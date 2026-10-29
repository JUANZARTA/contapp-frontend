import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { DropdownModule } from 'primeng/dropdown';
import { TableModule } from 'primeng/table';
import { firstValueFrom } from 'rxjs';
import { INVOICE_STATUS_LABEL, InvoiceStatus, SaleInvoice } from '../../models/billing-sale-invoice.model';
import { DOCUMENT_KIND_CONFIG, DocumentKind, KIND_FILTER_OPTIONS } from '../../models/document-kind';
import { CopCentsPipe } from '../../pipes/cop-cents.pipe';
import { BillingSaleInvoiceApi } from '../../services/billing-sale-invoice.api';
import { billingErrorMessage } from '../../utils/billing-error';
import { calcTotals } from '../../utils/money';
import { BillingKindTagComponent } from '../billing-kind-tag/billing-kind-tag.component';
import { BillingStatusBadgeComponent } from '../billing-status-badge/billing-status-badge.component';

// Listado de facturas de venta y de compra (filtro por estado y por tipo)
@Component({
  selector: 'app-sale-invoice-list',
  imports: [
    DatePipe,
    FormsModule,
    ButtonModule,
    DialogModule,
    DropdownModule,
    TableModule,
    CopCentsPipe,
    BillingKindTagComponent,
    BillingStatusBadgeComponent,
  ],
  templateUrl: './sale-invoice-list.component.html',
})
export class SaleInvoiceListComponent implements OnInit {
  private readonly api = inject(BillingSaleInvoiceApi);
  private readonly router = inject(Router);
  private readonly messages = inject(MessageService);

  invoices = signal<SaleInvoice[]>([]);
  loading = signal(true);
  statusFilter = signal<InvoiceStatus | null>(null);
  kindFilter = signal<DocumentKind | null>(null);
  readonly kindOptions = KIND_FILTER_OPTIONS;

  readonly statusOptions = [
    { label: 'Todos los estados', value: null },
    ...(Object.keys(INVOICE_STATUS_LABEL) as InvoiceStatus[]).map((s) => ({
      label: INVOICE_STATUS_LABEL[s],
      value: s,
    })),
  ];

  filtered = computed(() => {
    const status = this.statusFilter();
    const kind = this.kindFilter();
    return this.invoices().filter((i) => (!status || i.status === status) && (!kind || i.kind === kind));
  });

  // Diálogo de anulación
  annulTarget = signal<SaleInvoice | null>(null);
  annulReason = '';
  annulling = signal(false);

  ngOnInit(): void {
    this.load();
  }

  totalOf(invoice: SaleInvoice): number {
    return calcTotals(invoice.lines).totalCents;
  }

  counterpartyOf(invoice: SaleInvoice): string {
    return invoice.clientName ?? `Sin ${DOCUMENT_KIND_CONFIG[invoice.kind].counterpartyLower}`;
  }

  view(invoice: SaleInvoice): void {
    this.router.navigate([DOCUMENT_KIND_CONFIG[invoice.kind].basePath, invoice.id]);
  }

  goBack(): void {
    this.router.navigate(['/billing']);
  }

  openAnnul(invoice: SaleInvoice): void {
    this.annulReason = '';
    this.annulTarget.set(invoice);
  }

  closeAnnul(): void {
    this.annulTarget.set(null);
  }

  async confirmAnnul(): Promise<void> {
    if (this.annulling()) return; // reentrada: N clics => una sola anulación
    const target = this.annulTarget();
    if (!target) return;
    if (!this.annulReason.trim()) {
      this.messages.add({ severity: 'warn', summary: 'Motivo requerido', detail: 'Indica el motivo de la anulación.' });
      return;
    }
    this.annulling.set(true);
    try {
      await firstValueFrom(this.api.annul(target.id, this.annulReason));
      this.messages.add({ severity: 'success', summary: 'Factura anulada', detail: `${target.number} fue anulada.` });
      this.closeAnnul();
      this.load();
    } catch (e) {
      const detail = billingErrorMessage(e);
      this.messages.add({ severity: 'error', summary: 'No se pudo anular', detail });
    } finally {
      this.annulling.set(false);
    }
  }

  private load(): void {
    this.loading.set(true);
    this.api.list().subscribe((invoices) => {
      this.invoices.set(invoices);
      this.loading.set(false);
    });
  }
}
