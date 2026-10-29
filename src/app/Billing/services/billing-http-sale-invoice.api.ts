import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable, catchError, defer, forkJoin, map, of, switchMap, tap, throwError } from 'rxjs';
import { InvoiceStatus, SaleInvoice, SaleInvoiceDraftInput } from '../models/billing-sale-invoice.model';
import { DocumentKind } from '../models/document-kind';
import { BillingSaleInvoiceApi } from './billing-sale-invoice.api';
import { BillingDocumentKindRegistry, INVOICE_BASE } from './billing-document-kind-registry';
import { LocalStorageMethods } from '../../Shared/Methods/local-storage.method';
import { IDEMPOTENCY_HEADER, IdempotencyKeyStore } from './idempotency-key.store';

const KINDS: DocumentKind[] = ['SALE', 'PURCHASE'];

@Injectable()
export class BillingHttpSaleInvoiceApi extends BillingSaleInvoiceApi {
  private readonly http = inject(HttpClient);
  private readonly localStorageMethods = inject(LocalStorageMethods);
  private readonly registry = inject(BillingDocumentKindRegistry);
  private readonly idempotency = inject(IdempotencyKeyStore);

  private getEnterpriseId(): string {
    return this.localStorageMethods.getIdEnterprise();
  }

  private params(): HttpParams {
    return new HttpParams().set('enterpriseId', this.getEnterpriseId());
  }

  private fetchOf(kind: DocumentKind, id: string): Observable<SaleInvoice> {
    return this.http
      .get<SaleInvoice>(`${INVOICE_BASE[kind]}/${id}`, { params: this.params() })
      .pipe(tap((invoice) => this.registry.remember(invoice.id, kind)));
  }

  // Un id de otro tipo responde 404 (el back lo trata como inexistente), por eso se prueba venta y luego compra
  private resolveKind(id: string): Observable<DocumentKind> {
    const known = this.registry.kindOf(id);
    return known ? of(known) : this.getById(id).pipe(map(() => this.registry.kindOf(id) ?? 'SALE'));
  }

  list(status?: InvoiceStatus): Observable<SaleInvoice[]> {
    let params = this.params();
    if (status) {
      params = params.set('status', status);
    }
    // El listado del back es un resumen sin líneas; las pantallas necesitan la factura completa
    return forkJoin(
      KINDS.map((kind) =>
        this.http
          .get<{ id: string }[]>(INVOICE_BASE[kind], { params })
          .pipe(map((summaries) => summaries.map((s) => ({ id: s.id, kind })))),
      ),
    ).pipe(
      map((groups) => groups.flat()),
      tap((summaries) => summaries.forEach((s) => this.registry.remember(s.id, s.kind))),
      switchMap((summaries) =>
        summaries.length ? forkJoin(summaries.map((s) => this.fetchOf(s.kind, s.id))) : of<SaleInvoice[]>([]),
      ),
    );
  }

  getById(id: string): Observable<SaleInvoice> {
    const known = this.registry.kindOf(id);
    if (known) {
      return this.fetchOf(known, id);
    }
    return this.fetchOf('SALE', id).pipe(
      catchError((err: unknown) =>
        err instanceof HttpErrorResponse && err.status === 404 ? this.fetchOf('PURCHASE', id) : throwError(() => err),
      ),
    );
  }

  saveDraft(input: SaleInvoiceDraftInput): Observable<SaleInvoice> {
    const params = this.params();
    const kind = input.id ? (this.registry.kindOf(input.id) ?? input.kind) : input.kind;
    if (input.id) {
      return this.http
        .put<SaleInvoice>(`${INVOICE_BASE[kind]}/${input.id}`, input, { params })
        .pipe(tap((invoice) => this.registry.remember(invoice.id, kind)));
    }
    // Creación: la clave se toma al suscribir, así un reintento del mismo cuerpo reutiliza la misma clave
    return defer(() => {
      const scope = `invoice:${kind}`;
      const key = this.idempotency.keyFor(scope, input);
      return this.http
        .post<SaleInvoice>(INVOICE_BASE[kind], input, { params, headers: { [IDEMPOTENCY_HEADER]: key } })
        .pipe(
          tap((invoice) => {
            this.idempotency.release(scope, key);
            this.registry.remember(invoice.id, kind);
          }),
        );
    });
  }

  deleteDraft(id: string): Observable<void> {
    return this.resolveKind(id).pipe(
      switchMap((kind) => this.http.delete<void>(`${INVOICE_BASE[kind]}/${id}`, { params: this.params() })),
    );
  }

  emit(id: string): Observable<SaleInvoice> {
    return this.resolveKind(id).pipe(
      switchMap((kind) => this.http.post<SaleInvoice>(`${INVOICE_BASE[kind]}/${id}/emit`, {}, { params: this.params() })),
    );
  }

  annul(id: string, reason: string): Observable<SaleInvoice> {
    return this.resolveKind(id).pipe(
      switchMap((kind) =>
        this.http.post<SaleInvoice>(`${INVOICE_BASE[kind]}/${id}/annul`, { reason }, { params: this.params() }),
      ),
    );
  }
}
