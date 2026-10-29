import { DatePipe, Location } from '@angular/common';
import { Component, DestroyRef, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ConfirmationService, MessageService, SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { DropdownModule } from 'primeng/dropdown';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { Subject, debounceTime, firstValueFrom } from 'rxjs';
import {
  BillingClient,
  BillingProduct,
  InvoiceStatus,
  SaleInvoice,
  SaleInvoiceLine,
} from '../../models/billing-sale-invoice.model';
import { ReturnAvailabilityLine, SaleReturn } from '../../models/billing-sale-return.model';
import { DOCUMENT_KIND_CONFIG, DocumentKind } from '../../models/document-kind';
import { CopCentsPipe } from '../../pipes/cop-cents.pipe';
import { BillingCounterpartyCatalog } from '../../services/billing-counterparty-catalog';
import { BillingProductCatalog } from '../../services/billing-product-catalog';
import { BillingSaleInvoiceApi } from '../../services/billing-sale-invoice.api';
import { BillingSaleReturnApi } from '../../services/billing-sale-return.api';
import { SaleReturnPreviewComponent } from '../sale-return-preview/sale-return-preview.component';
import { calcReturnTotals, deriveReturnState, returnOrdinals } from '../../utils/sale-return';
import { billingErrorMessage } from '../../utils/billing-error';
import { buildReturnQuery } from '../../utils/return-trail';
import { calcTotals, centsToPesos, lineSubtotalCents, pesosToCents } from '../../utils/money';
import { BillingStatusBadgeComponent } from '../billing-status-badge/billing-status-badge.component';
import { SaleInvoicePreviewComponent } from '../sale-invoice-preview/sale-invoice-preview.component';

type SaveState = 'idle' | 'pending' | 'saving' | 'saved';

const AUTOSAVE_DEBOUNCE_MS = 800;

const todayIso = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Formulario de factura de venta Y de compra. El tipo llega por `data.kind` de la ruta
// (sale/* o purchase/*) y, al cargar una factura existente, prevalece el de la factura.
// clientId/clientName = contraparte: cliente en ventas, proveedor en compras.
@Component({
  selector: 'app-sale-invoice-form',
  imports: [
    FormsModule,
    ButtonModule,
    ConfirmDialogModule,
    DatePipe,
    SharedModule,
    DialogModule,
    DropdownModule,
    InputNumberModule,
    TableModule,
    CopCentsPipe,
    BillingStatusBadgeComponent,
    SaleInvoicePreviewComponent,
    SaleReturnPreviewComponent,
  ],
  providers: [ConfirmationService],
  templateUrl: './sale-invoice-form.component.html',
})
export class SaleInvoiceFormComponent implements OnInit, OnDestroy {
  private readonly api = inject(BillingSaleInvoiceApi);
  private readonly catalog = inject(BillingProductCatalog);
  private readonly counterpartyCatalog = inject(BillingCounterpartyCatalog);
  private readonly returnApi = inject(BillingSaleReturnApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly messages = inject(MessageService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  // Catálogos
  products = signal<BillingProduct[]>([]);
  clients = signal<BillingClient[]>([]);

  // Estado de la factura
  kind = signal<DocumentKind>('SALE');
  cfg = computed(() => DOCUMENT_KIND_CONFIG[this.kind()]);
  invoiceId = signal<string | null>(null);
  number = signal<string | null>(null);
  status = signal<InvoiceStatus>('BORRADOR');
  clientId = signal<string | null>(null);
  supplierInvoiceNumber = signal<string>(''); // solo compras
  date = signal<string>(todayIso());
  lines = signal<SaleInvoiceLine[]>([]);
  annulReason = signal<string | null>(null);

  // UI
  loading = signal(true);
  busy = signal(false);
  saveState = signal<SaveState>('idle');
  previewVisible = signal(false);
  selectedProductId: string | null = null;

  // Solo el borrador es editable; EMITIDA/ANULADA son de solo lectura total
  editable = computed(() => this.status() === 'BORRADOR');
  totals = computed(() => calcTotals(this.lines()));
  selectedClient = computed(() => this.clients().find((c) => c.id === this.clientId()) ?? null);
  clientName = computed(() => this.clients().find((c) => c.id === this.clientId())?.name ?? '—');

  // Devoluciones de esta factura (solo se cargan cuando ya no es borrador)
  returns = signal<SaleReturn[]>([]);
  availability = signal<ReturnAvailabilityLine[]>([]);
  // El botón "Devolución" solo aparece en una EMITIDA con algo aún devolvible
  canReturn = computed(() => this.status() === 'EMITIDA' && this.availability().some((a) => a.available > 0));
  returnOrdinalMap = computed(() => returnOrdinals(this.returns()));
  previewReturn = signal<SaleReturn | null>(null);
  returnState = computed(() => deriveReturnState(this.lines(), this.returns()));

  // Para habilitar luego la edición de más campos de la línea, basta agregar aquí el campo
  // y su input en la plantilla (hoy solo el precio unitario es editable).
  readonly editableLineFields = ['precioUnitario'] as const;

  private dirty = false;
  private readonly autosave$ = new Subject<void>();
  // Cadena de guardados: serializa las escrituras para no crear borradores duplicados
  private saveChain: Promise<unknown> = Promise.resolve();

  ngOnInit(): void {
    this.kind.set(this.route.snapshot.data['kind'] ?? 'SALE');
    this.loadProducts();
    this.loadCounterparties();

    this.autosave$
      .pipe(debounceTime(AUTOSAVE_DEBOUNCE_MS), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.persist().catch(() => this.saveState.set('idle')));

    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.loading.set(false);
      return;
    }
    this.api
      .getById(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (invoice) => {
          // La factura manda: si la ruta no coincide con su tipo, se recargan los catálogos del tipo real
          if (invoice.kind !== this.kind()) {
            this.kind.set(invoice.kind);
            this.loadProducts();
            this.loadCounterparties();
          }
          this.applyInvoice(invoice);
          this.loading.set(false);
          if (invoice.status !== 'BORRADOR') this.loadReturns(invoice);
        },
        error: () => {
          this.toast('error', 'Factura no encontrada', 'No existe la factura solicitada.');
          this.router.navigate(['/billing/pending']);
        },
      });
  }

  ngOnDestroy(): void {
    // Al salir de la pantalla se persiste lo pendiente (el mock escribe de forma síncrona)
    if (this.dirty && this.editable()) this.persist().catch(() => undefined);
  }

  // --- devoluciones ---

  private loadReturns(invoice: SaleInvoice): void {
    this.returnApi
      .listByInvoice(invoice.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((list) => this.returns.set(list));
    if (invoice.status !== 'EMITIDA') return; // solo una factura emitida se puede devolver
    this.returnApi
      .getAvailability(invoice.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((a) => this.availability.set(a));
  }

  newReturn(): void {
    this.router.navigate([this.cfg().basePath, this.invoiceId(), 'return', 'new']);
  }

  openReturn(saleReturn: SaleReturn): void {
    this.router.navigate(['/billing/return', saleReturn.id]);
  }

  ordinalOf(saleReturn: SaleReturn): number | null {
    return this.returnOrdinalMap().get(saleReturn.id) ?? null;
  }

  openReturnPreview(saleReturn: SaleReturn): void {
    this.previewReturn.set(saleReturn);
  }

  returnTotal(saleReturn: SaleReturn): number {
    return calcReturnTotals(saleReturn.lines).totalCents;
  }

  // --- catálogo de productos ---

  private loadProducts(): void {
    this.catalog
      .getProducts(this.kind())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => {
        this.products.set(p);
        if (this.selectedProductId && !p.some((x) => x.id === this.selectedProductId)) {
          this.selectedProductId = null;
        }
      });
  }

  private loadCounterparties(): void {
    this.counterpartyCatalog
      .getCounterparties(this.kind())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((c) => this.clients.set(c));
  }

  // Al volver de crear/editar productos (pestaña o ventana recupera el foco) se recarga
  @HostListener('window:focus')
  @HostListener('document:visibilitychange')
  onReturnToWindow(): void {
    if (document.visibilityState === 'visible' && this.editable()) this.loadProducts();
  }

  /** Atajo a Productos: asegura el borrador guardado y deja el rastro para volver. */
  async createProduct(): Promise<void> {
    if (!this.editable() || this.busy()) return;
    this.busy.set(true);
    try {
      await this.persist(); // vacía el autosave pendiente; no crea borrador si está vacío
      const returnTo = `${this.cfg().basePath}/${this.invoiceId() ?? 'new'}`;
      await this.router.navigate(['/gen-masters/inventory/products/list'], {
        queryParams: buildReturnQuery(returnTo),
      });
    } catch (e) {
      this.toast('error', 'No se pudo guardar el borrador', this.errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Atajo a Clientes/Proveedores: asegura el borrador guardado y deja el rastro para volver. */
  async createClient(): Promise<void> {
    if (!this.editable() || this.busy()) return;
    this.busy.set(true);
    try {
      await this.persist();
      const returnTo = `${this.cfg().basePath}/${this.invoiceId() ?? 'new'}`;
      await this.router.navigate(['/gen-masters/third-parties/list'], {
        queryParams: buildReturnQuery(returnTo),
      });
    } catch (e) {
      this.toast('error', 'No se pudo guardar el borrador', this.errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  // --- edición de cabecera y líneas ---

  onClientChange(id: string | null): void {
    this.clientId.set(id);
    this.markDirty();
  }

  onSupplierInvoiceNumberChange(value: string): void {
    this.supplierInvoiceNumber.set(value ?? '');
    this.markDirty();
  }

  onDateChange(value: string): void {
    this.date.set(value || todayIso());
    this.markDirty();
  }

  addProduct(): void {
    const product = this.products().find((p) => p.id === this.selectedProductId);
    if (!product) return;

    const existing = this.lines().findIndex((l) => l.productId === product.id);
    if (existing >= 0) {
      this.setQuantity(existing, this.lines()[existing].cantidad + 1);
    } else {
      this.lines.update((lines) => [
        ...lines,
        {
          productId: product.id,
          productName: product.name,
          cantidad: 1,
          precioCatalogoCents: product.priceCents,
          precioUnitarioCents: product.priceCents,
          ivaCatalogoPct: product.ivaPct,
          ivaPct: product.ivaPct,
        },
      ]);
      this.markDirty();
    }
    this.selectedProductId = null;
  }

  setQuantity(index: number, value: number | null): void {
    this.updateLine(index, { cantidad: Math.max(0, Math.trunc(value ?? 0)) });
  }

  // El precio editado por el usuario prevalece; el de catálogo queda como referencia
  setUnitPrice(index: number, pesos: number | null): void {
    this.updateLine(index, { precioUnitarioCents: pesosToCents(pesos ?? 0) });
  }

  // El IVA editado por el usuario prevalece; el del producto queda como referencia
  setIva(index: number, pct: number | null): void {
    this.updateLine(index, { ivaPct: Math.min(100, Math.max(0, pct ?? 0)) });
  }

  removeLine(index: number): void {
    this.lines.update((lines) => lines.filter((_, i) => i !== index));
    this.markDirty();
  }

  // --- acciones ---

  async saveDraft(): Promise<void> {
    // Reentrada: mientras hay una acción en curso, los clics extra se ignoran (aunque el botón tarde en deshabilitarse)
    if (!this.editable() || this.busy()) return;
    this.busy.set(true);
    try {
      await this.persist(true);
      this.toast('success', 'Borrador guardado', 'Los cambios se guardaron correctamente.');
    } catch (e) {
      this.toast('error', 'No se pudo guardar', this.errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  confirmEmit(): void {
    if (this.busy()) return;
    const error = this.validateForEmit();
    if (error) {
      this.toast('warn', 'No se puede emitir', error);
      return;
    }
    this.confirmation.confirm({
      header: 'Emitir factura',
      icon: 'pi pi-exclamation-triangle',
      message: 'Al emitir se asignará el número y la factura ya no podrá modificarse ni eliminarse. ¿Continuar?',
      acceptLabel: 'Emitir',
      rejectLabel: 'Cancelar',
      accept: () => this.emit(),
    });
  }

  confirmDelete(): void {
    if (this.busy()) return;
    this.confirmation.confirm({
      header: 'Eliminar borrador',
      icon: 'pi pi-exclamation-triangle',
      message: '¿Seguro que deseas eliminar este borrador? Esta acción no se puede deshacer.',
      acceptLabel: 'Eliminar',
      rejectLabel: 'Cancelar',
      accept: () => this.deleteDraft(),
    });
  }

  // Vuelve a la pantalla anterior de la app; si no hay (F5, link directo) cae al menú de Facturación.
  // Angular guarda `navigationId` en history.state: > 1 significa que hubo una navegación previa.
  goBack(): void {
    const hasAppHistory = (window.history.state?.navigationId ?? 0) > 1;
    if (hasAppHistory) {
      this.location.back();
    } else {
      this.router.navigate(['/billing']);
    }
  }

  // --- internos ---

  private async emit(): Promise<void> {
    if (this.busy()) return; // bandera de reentrada: N clics => una sola emisión
    this.busy.set(true);
    try {
      await this.persist(); // asegura que lo último editado quede guardado antes de emitir
      const emitted = await firstValueFrom(this.api.emit(this.invoiceId()!));
      this.applyInvoice(emitted);
      this.loadReturns(emitted); // habilita el botón "Devolución"
      this.toast('success', 'Factura emitida', `Se asignó el número ${emitted.number}.`);
    } catch (e) {
      this.toast('error', 'No se pudo emitir', this.errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async deleteDraft(): Promise<void> {
    if (this.busy()) return;
    const id = this.invoiceId();
    this.dirty = false; // evita que ngOnDestroy vuelva a guardar lo que se acaba de borrar
    this.busy.set(true);
    try {
      if (id) await firstValueFrom(this.api.deleteDraft(id));
      this.toast('success', 'Borrador eliminado', 'El borrador fue eliminado.');
      this.router.navigate(['/billing']);
    } catch (e) {
      this.toast('error', 'No se pudo eliminar', this.errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private validateForEmit(): string | null {
    if (!this.clientId()) return `Debes seleccionar un ${this.cfg().counterpartyLower}.`;
    if (this.kind() === 'PURCHASE' && !this.supplierInvoiceNumber().trim()) {
      return 'Debes ingresar el N.º de factura del proveedor.';
    }
    if (this.lines().length === 0) return 'Agrega al menos una línea a la factura.';
    if (this.lines().some((l) => !(l.cantidad > 0))) return 'Todas las líneas deben tener cantidad mayor a cero.';
    return null;
  }

  private updateLine(index: number, patch: Partial<SaleInvoiceLine>): void {
    this.lines.update((lines) => lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    this.saveState.set('pending');
    this.autosave$.next();
  }

  /** Encola un guardado del estado ACTUAL del formulario. `force` guarda aunque no haya cambios. */
  private persist(force = false): Promise<SaleInvoice | null> {
    const run = async (): Promise<SaleInvoice | null> => {
      const hasContent =
        !!this.invoiceId() ||
        !!this.clientId() ||
        !!this.supplierInvoiceNumber().trim() ||
        this.lines().length > 0;
      if ((!this.dirty && !force) || !hasContent) {
        this.dirty = false;
        this.saveState.set(this.invoiceId() ? 'saved' : 'idle');
        return null;
      }
      this.dirty = false;
      this.saveState.set('saving');
      try {
        const saved = await firstValueFrom(
          this.api.saveDraft({
            id: this.invoiceId() ?? undefined,
            kind: this.kind(),
            clientId: this.clientId(),
            supplierInvoiceNumber: this.supplierInvoiceNumber(),
            date: this.date(),
            lines: this.lines(),
          }),
        );
        if (!this.invoiceId()) {
          this.invoiceId.set(saved.id);
          // Cambia la URL a /sale/:id (o /purchase/:id) sin recrear el componente
          this.location.replaceState(`${this.cfg().basePath}/${saved.id}`);
        }
        // Si el usuario siguió editando durante el guardado, queda pendiente
        this.saveState.set(this.dirty ? 'pending' : 'saved');
        return saved;
      } catch (e) {
        this.dirty = true;
        this.saveState.set('idle');
        throw e;
      }
    };
    const result = this.saveChain.then(run);
    this.saveChain = result.catch(() => undefined);
    return result;
  }

  private applyInvoice(invoice: SaleInvoice): void {
    this.invoiceId.set(invoice.id);
    this.number.set(invoice.number);
    this.status.set(invoice.status);
    this.clientId.set(invoice.clientId);
    this.supplierInvoiceNumber.set(invoice.supplierInvoiceNumber ?? '');
    this.date.set(invoice.date);
    this.lines.set(invoice.lines);
    this.annulReason.set(invoice.annulReason ?? null);
    this.dirty = false;
    this.saveState.set(invoice.status === 'BORRADOR' ? 'saved' : 'idle');
  }

  private toast(severity: 'success' | 'warn' | 'error', summary: string, detail: string): void {
    this.messages.add({ severity, summary, detail });
  }

  private errorMessage(e: unknown): string {
    return billingErrorMessage(e); // incluye BILLING_IDEMPOTENCY_CONFLICT (409)
  }

  // Helpers expuestos a la plantilla
  lineSubtotal = lineSubtotalCents;
  toPesos = centsToPesos;
}
