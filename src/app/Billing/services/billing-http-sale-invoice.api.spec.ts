import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { LocalStorageMethods } from '../../Shared/Methods/local-storage.method';
import { SaleInvoice, SaleInvoiceDraftInput } from '../models/billing-sale-invoice.model';
import { BillingHttpSaleInvoiceApi } from './billing-http-sale-invoice.api';
import { IDEMPOTENCY_HEADER } from './idempotency-key.store';

const URL_SALE = '/api/billing/sale-invoices';

const input = (over: Partial<SaleInvoiceDraftInput> = {}): SaleInvoiceDraftInput => ({
  kind: 'SALE',
  clientId: 'c1',
  date: '2026-10-27',
  lines: [],
  ...over,
});

describe('BillingHttpSaleInvoiceApi (idempotencia)', () => {
  let api: BillingHttpSaleInvoiceApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        BillingHttpSaleInvoiceApi,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LocalStorageMethods, useValue: { getIdEnterprise: () => 'ent-1' } },
      ],
    });
    api = TestBed.inject(BillingHttpSaleInvoiceApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  const nextPost = () => httpMock.expectOne((r) => r.method === 'POST' && r.url === URL_SALE);

  it('el POST de creación envía el header Idempotency-Key', () => {
    api.saveDraft(input()).subscribe();
    const req = nextPost();
    expect(req.request.headers.get(IDEMPOTENCY_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    req.flush({ id: 'i1' } as SaleInvoice);
  });

  it('el reintento tras un error reutiliza la misma clave', () => {
    api.saveDraft(input()).subscribe({ error: () => undefined });
    const first = nextPost();
    const key = first.request.headers.get(IDEMPOTENCY_HEADER);
    first.flush({ code: 'BILLING_SEQUENCE_BUSY' }, { status: 503, statusText: 'Service Unavailable' });

    api.saveDraft(input()).subscribe();
    const retry = nextPost();
    expect(retry.request.headers.get(IDEMPOTENCY_HEADER)).toBe(key);
    retry.flush({ id: 'i1' } as SaleInvoice);
  });

  it('dos envíos simultáneos del mismo cuerpo comparten clave', () => {
    api.saveDraft(input()).subscribe();
    api.saveDraft(input()).subscribe();
    const reqs = httpMock.match((r) => r.method === 'POST' && r.url === URL_SALE);
    expect(reqs.length).toBe(2);
    expect(reqs[0].request.headers.get(IDEMPOTENCY_HEADER)).toBe(reqs[1].request.headers.get(IDEMPOTENCY_HEADER));
    reqs.forEach((r) => r.flush({ id: 'i1' } as SaleInvoice));
  });

  it('tras un éxito la siguiente creación usa una clave nueva', () => {
    api.saveDraft(input()).subscribe();
    const first = nextPost();
    const key = first.request.headers.get(IDEMPOTENCY_HEADER);
    first.flush({ id: 'i1' } as SaleInvoice);

    api.saveDraft(input()).subscribe();
    const second = nextPost();
    expect(second.request.headers.get(IDEMPOTENCY_HEADER)).not.toBe(key);
    second.flush({ id: 'i2' } as SaleInvoice);
  });

  it('si el contenido cambió, el reintento usa una clave nueva', () => {
    api.saveDraft(input()).subscribe({ error: () => undefined });
    const first = nextPost();
    const key = first.request.headers.get(IDEMPOTENCY_HEADER);
    first.flush(null, { status: 0, statusText: 'red' });

    api.saveDraft(input({ clientId: 'c2' })).subscribe();
    const changed = nextPost();
    expect(changed.request.headers.get(IDEMPOTENCY_HEADER)).not.toBe(key);
    changed.flush({ id: 'i1' } as SaleInvoice);
  });

  it('el PUT, emit y annul no envían la clave', () => {
    api.saveDraft(input({ id: 'i1' })).subscribe();
    const put = httpMock.expectOne((r) => r.method === 'PUT');
    expect(put.request.headers.has(IDEMPOTENCY_HEADER)).toBeFalse();
    put.flush({ id: 'i1' } as SaleInvoice);

    api.emit('i1').subscribe();
    const emit = httpMock.expectOne((r) => r.url.endsWith('/i1/emit'));
    expect(emit.request.headers.has(IDEMPOTENCY_HEADER)).toBeFalse();
    emit.flush({ id: 'i1' } as SaleInvoice);
  });
});
