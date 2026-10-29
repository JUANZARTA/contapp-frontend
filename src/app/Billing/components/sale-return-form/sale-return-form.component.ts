import { DatePipe, Location } from '@angular/common';
import { Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ConfirmationService, MessageService, SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { Subject, debounceTime, firstValueFrom, forkJoin } from 'rxjs';
import { InvoiceStatus } from '../../models/billing-sale-invoice.model';
import { ReturnAvailabilityLine, SaleReturn } from '../../models/billing-sale-return.model';
import { DOCUMENT_KIND_CONFIG, DocumentKind } from '../../models/document-kind';
import { CopCentsPipe } from '../../pipes/cop-cents.pipe';
import { BillingSaleInvoiceApi } from '../../services/billing-sale-invoice.api';
import { BillingSaleReturnApi } from '../../services/billing-sale-return.api';
import { billingErrorMessage } from '../../utils/billing-error';
import { calcReturnTotals, returnLineSubtotalCents } from '../../utils/sale-return';
import { BillingStatusBadgeComponent } from '../billing-status-badge/billing-status-badge.component';

type SaveState = 'idle' | 'pending' | 'saving' | 'saved';

// Fila de la tabla: disponibilidad de la línea original + lo que el usuario devuelve
type ReturnRow = ReturnAvailabilityLine & { cantidadDevuelta: number };

const AUTOSAVE_DEBOUNCE_MS = 800;

const todayIso = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Formulario de devolución de venta Y de compra (mismas reglas). El tipo llega por `data.kind` en
// sale|purchase/:invoiceId/return/new; en return/:id (sin data) se toma de la devolución cargada.
// clientName = contraparte: cliente en ventas, proveedor en compras.
@Component({
  selector: 'app-sale-return-form',
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    ConfirmDialogModule,
    SharedModule,
    DialogModule,
    InputNumberModule,
    TableModule,
    CopCentsPipe,
    BillingStatusBadgeComponent,
  ],
  providers: [ConfirmationService],
  templateUrl: './sale-return-form.component.html',
})
export class SaleReturnFormComponent implements OnInit, OnDestroy {
  private readonly api = inject(BillingSaleReturnApi);
  private readonly invoiceApi = inject(BillingSaleInvoiceApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly messages = inject(MessageService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  // Estado de la devolución
  kind = signal<DocumentKind>('SALE');
  cfg = computed(() => DOCUMENT_KIND_CONFIG[this.kind()]);
  returnId = signal<string | null>(null);
  invoiceId = signal<string>('');
  number = signal<string | null>(null);
  status = signal<InvoiceStatus>('BORRADOR');
  originalNumber = signal<string | null>(null);
  originalDate = signal<string>('');
  clientName = signal<string | null>(null);
  supplierInvoiceNumber = signal<string | null>(null); // solo compras
  date = signal<string>(todayIso());
  reason = signal<string>('');
  rows = signal<ReturnRow[]>([]);
  annulReason = signal<string | null>(null);

  // UI
  loading = signal(true);
  busy = signal(false);
  saveState = signal<SaveState>('idle');

  // Diálogo de anulación
  annulVisible = signal(false);
  annulReasonText = '';
  annulling = signal(false);

  // Solo el borrador es editable; EMITIDA/ANULADA son de solo lectura total
  editable = computed(() => this.status() === 'BORRADOR');
  totals = computed(() => calcReturnTotals(this.rows()));

  private dirty = false;
  private readonly autosave$ = new Subject<void>();
  // Cadena de guardados: serializa las escrituras para no crear borradores duplicados
  private saveChain: Promise<unknown> = Promise.resolve();

  ngOnInit(): void {
    this.kind.set(this.route.snapshot.data['kind'] ?? 'SALE');
    this.autosave$
      .pipe(debounceTime(AUTOSAVE_DEBOUNCE_MS), takeUntilDestroyed(this.destroyRef))
      .subscribe(() =>
        this.persist().catch((e) => {
          this.saveState.set('idle');
          this.toast('error', 'No se pudo guardar', this.errorMessage(e));
        }),
      );

    const id = this.route.snapshot.paramMap.get('id');
    if (id) this.loadExisting(id);
    else this.loadNew(this.route.snapshot.paramMap.get('invoiceId') ?? '');
  }

  ngOnDestroy(): void {
    // Al salir de la pantalla se persiste lo pendiente (el mock escribe de forma síncrona)
    if (this.dirty && this.editable()) this.persist().catch(() => undefined);
  }

  // --- carga ---

  // Devolución nueva: los datos salen de la factura original y de su disponibilidad
  private loadNew(invoiceId: string): void {
    this.invoiceId.set(invoiceId);
    forkJoin([this.invoiceApi.getById(invoiceId), this.api.getAvailability(invoiceId)])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ([invoice, availability]) => {
          this.kind.set(invoice.kind); // la factura manda sobre la ruta
          if (!availability.some((a) => a.available > 0)) {
            this.toast('warn', 'Sin cantidades disponibles', 'Esta factura ya fue devuelta por completo.');
            this.router.navigate([this.cfg().basePath, invoiceId]);
            return;
          }
          this.originalNumber.set(invoice.number);
          this.originalDate.set(invoice.date);
          this.clientName.set(invoice.clientName);
          this.supplierInvoiceNumber.set(invoice.supplierInvoiceNumber ?? null);
          this.rows.set(availability.map((a) => ({ ...a, cantidadDevuelta: 0 })));
          this.loading.set(false);
        },
        error: (e) => {
          this.toast('error', 'No se puede devolver', this.errorMessage(e));
          this.router.navigate([this.cfg().basePath, invoiceId]);
        },
      });
  }

  private loadExisting(id: string): void {
    this.api
      .getById(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (saleReturn) => {
          this.applyReturn(saleReturn);
          if (saleReturn.status !== 'BORRADOR') {
            this.loading.set(false);
            return;
          }
          // Un borrador sigue siendo editable: necesita la disponibilidad vigente por línea
          this.api
            .getAvailability(saleReturn.invoiceId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (availability) => {
                this.rows.set(
                  availability.map((a) => {
                    const saved = saleReturn.lines.find((l) => l.productId === a.productId)?.cantidadDevuelta ?? 0;
                    return { ...a, cantidadDevuelta: Math.min(saved, a.available) };
                  }),
                );
                this.loading.set(false);
              },
              error: (e) => {
                this.toast('error', 'No se pudo cargar la disponibilidad', this.errorMessage(e));
                this.router.navigate([this.cfg().basePath, saleReturn.invoiceId]);
              },
            });
        },
        error: () => {
          this.toast('error', 'Devolución no encontrada', 'No existe la devolución solicitada.');
          this.router.navigate(['/billing/returns']);
        },
      });
  }

  // --- edición ---

  onDateChange(value: string): void {
    this.date.set(value || todayIso());
    this.markDirty();
  }

  onReasonChange(value: string): void {
    this.reason.set(value ?? '');
    this.markDirty();
  }

  // La cantidad se limita a [0, disponible]
  setQuantity(index: number, value: number | null): void {
    this.rows.update((rows) =>
      rows.map((r, i) =>
        i === index ? { ...r, cantidadDevuelta: Math.min(r.available, Math.max(0, Math.trunc(value ?? 0))) } : r,
      ),
    );
    this.markDirty();
  }

  // --- acciones ---

  confirmEmit(): void {
    if (this.busy()) return;
    const error = this.validateForEmit();
    if (error) {
      this.toast('warn', 'No se puede emitir', error);
      return;
    }
    this.confirmation.confirm({
      header: 'Emitir devolución',
      icon: 'pi pi-exclamation-triangle',
      message: `Al emitir se asignará el número de la ${this.cfg().noteShort} y la devolución ya no podrá modificarse ni eliminarse. ¿Continuar?`,
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

  openAnnul(): void {
    this.annulReasonText = '';
    this.annulVisible.set(true);
  }

  closeAnnul(): void {
    this.annulVisible.set(false);
  }

  async confirmAnnul(): Promise<void> {
    if (this.annulling()) return; // reentrada: N clics => una sola anulación
    if (!this.annulReasonText.trim()) {
      this.toast('warn', 'Motivo requerido', 'Indica el motivo de la anulación.');
      return;
    }
    this.annulling.set(true);
    try {
      const annulled = await firstValueFrom(this.api.annul(this.returnId()!, this.annulReasonText));
      this.applyReturn(annulled);
      this.closeAnnul();
      this.toast('success', 'Devolución anulada', `${annulled.number} fue anulada.`);
    } catch (e) {
      this.toast('error', 'No se pudo anular', this.errorMessage(e));
    } finally {
      this.annulling.set(false);
    }
  }

  // Vuelve a la pantalla anterior de la app; si no hay (F5, link directo) cae a la factura original.
  // Angular guarda `navigationId` en history.state: > 1 significa que hubo una navegación previa.
  goBack(): void {
    const hasAppHistory = (window.history.state?.navigationId ?? 0) > 1;
    if (hasAppHistory) {
      this.location.back();
    } else {
      this.router.navigate([this.cfg().basePath, this.invoiceId()]);
    }
  }

  // --- internos ---

  private async emit(): Promise<void> {
    if (this.busy()) return; // bandera de reentrada: N clics => una sola emisión
    this.busy.set(true);
    try {
      await this.persist(true); // asegura que lo último editado quede guardado antes de emitir
      const emitted = await firstValueFrom(this.api.emit(this.returnId()!));
      this.applyReturn(emitted);
      this.toast('success', 'Devolución emitida', `Se asignó el número ${emitted.number}.`);
    } catch (e) {
      this.toast('error', 'No se pudo emitir', this.errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async deleteDraft(): Promise<void> {
    if (this.busy()) return;
    const id = this.returnId();
    this.dirty = false; // evita que ngOnDestroy vuelva a guardar lo que se acaba de borrar
    this.busy.set(true);
    try {
      if (id) await firstValueFrom(this.api.deleteDraft(id));
      this.toast('success', 'Borrador eliminado', 'El borrador fue eliminado.');
      this.router.navigate([this.cfg().basePath, this.invoiceId()]);
    } catch (e) {
      this.toast('error', 'No se pudo eliminar', this.errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private validateForEmit(): string | null {
    if (!this.rows().some((r) => r.cantidadDevuelta > 0)) return 'Indica la cantidad a devolver de al menos un producto.';
    if (!this.reason().trim()) return 'El motivo de la devolución es obligatorio.';
    return null;
  }

  private markDirty(): void {
    this.dirty = true;
    this.saveState.set('pending');
    this.autosave$.next();
  }

  /** Encola un guardado del estado ACTUAL. `force` guarda aunque no haya cambios. */
  private persist(force = false): Promise<SaleReturn | null> {
    const run = async (): Promise<SaleReturn | null> => {
      // El borrador se crea solo cuando hay algo que guardar: alguna cantidad o el motivo
      const hasContent =
        !!this.returnId() || this.rows().some((r) => r.cantidadDevuelta > 0) || !!this.reason().trim();
      if ((!this.dirty && !force) || !hasContent) {
        this.dirty = false;
        this.saveState.set(this.returnId() ? 'saved' : 'idle');
        return null;
      }
      this.dirty = false;
      this.saveState.set('saving');
      try {
        const saved = await firstValueFrom(
          this.api.saveDraft({
            id: this.returnId() ?? undefined,
            invoiceId: this.invoiceId(),
            date: this.date(),
            reason: this.reason(),
            lines: this.rows().map((r) => ({ productId: r.productId, cantidad: r.cantidadDevuelta })),
          }),
        );
        if (!this.returnId()) {
          this.returnId.set(saved.id);
          // Cambia la URL a /return/:id sin recrear el componente
          this.location.replaceState(`/billing/return/${saved.id}`);
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

  // Aplica el documento. En BORRADOR las filas se construyen aparte (con la disponibilidad);
  // en EMITIDA/ANULADA se muestran las líneas congeladas del documento.
  private applyReturn(saleReturn: SaleReturn): void {
    this.kind.set(saleReturn.kind);
    this.returnId.set(saleReturn.id);
    this.invoiceId.set(saleReturn.invoiceId);
    this.number.set(saleReturn.number);
    this.status.set(saleReturn.status);
    this.originalNumber.set(saleReturn.originalNumber);
    this.originalDate.set(saleReturn.originalDate);
    this.clientName.set(saleReturn.clientName);
    this.supplierInvoiceNumber.set(saleReturn.supplierInvoiceNumber ?? null);
    this.date.set(saleReturn.date);
    this.reason.set(saleReturn.reason);
    this.annulReason.set(saleReturn.annulReason ?? null);
    if (saleReturn.status !== 'BORRADOR') {
      this.rows.set(
        saleReturn.lines.map((l) => ({
          productId: l.productId,
          productName: l.productName,
          sold: l.cantidadVendida ?? 0,
          returned: 0,
          available: 0,
          cantidadDevuelta: l.cantidadDevuelta,
          precioUnitarioCents: l.precioUnitarioCents,
          ivaPct: l.ivaPct,
        })),
      );
    }
    this.dirty = false;
    this.saveState.set(saleReturn.status === 'BORRADOR' ? 'saved' : 'idle');
  }

  private toast(severity: 'success' | 'warn' | 'error', summary: string, detail: string): void {
    this.messages.add({ severity, summary, detail });
  }

  private errorMessage(e: unknown): string {
    return billingErrorMessage(e); // incluye BILLING_IDEMPOTENCY_CONFLICT (409)
  }

  // Helper expuesto a la plantilla
  rowSubtotal = returnLineSubtotalCents;
}
