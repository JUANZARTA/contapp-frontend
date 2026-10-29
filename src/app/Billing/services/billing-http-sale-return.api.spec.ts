import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { LocalStorageMethods } from '../../Shared/Methods/local-storage.method';
import { SaleReturnDraftInput } from '../models/billing-sale-return.model';
import { BillingHttpSaleReturnApi } from './billing-http-sale-return.api';
import { IDEMPOTENCY_HEADER } from './idempotency-key.store';

const AVAILABILITY = {
  lines: [{ lineNo: 1, productId: 'p1', productName: 'P', sold: 5, returned: 0, available: 5, precioUnitarioCents: 100, ivaPct: 19 }],
};

const input = (over: Partial<SaleReturnDraftInput> = {}): SaleReturnDraftInput => ({
  invoiceId: 'inv-1',
  date: '2026-10-27',
  reason: 'defecto',
  lines: [{ productId: 'p1', cantidad: 1 }],
  ...over,
});

describe('BillingHttpSaleReturnApi (idempotencia)', () => {
  let api: BillingHttpSaleReturnApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        BillingHttpSaleReturnApi,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LocalStorageMethods, useValue: { getIdEnterprise: () => 'ent-1' } },
      ],
    });
    api = TestBed.inject(BillingHttpSaleReturnApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  // saveDraft primero consulta la disponibilidad (venta) y luego hace el POST
  const post = (): TestRequest => {
    httpMock.expectOne((r) => r.method === 'GET' && r.url.endsWith('/return-availability')).flush(AVAILABILITY);
    return httpMock.expectOne((r) => r.method === 'POST' && r.url === '/api/billing/sale-returns');
  };

  it('el POST de creación envía el header Idempotency-Key', () => {
    api.saveDraft(input()).subscribe({ error: () => undefined });
    const req = post();
    expect(req.request.headers.get(IDEMPOTENCY_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    req.flush(null, { status: 500, statusText: 'x' });
  });

  it('el reintento del mismo cuerpo reutiliza la clave y tras el éxito se renueva', () => {
    api.saveDraft(input()).subscribe({ error: () => undefined });
    const first = post();
    const key = first.request.headers.get(IDEMPOTENCY_HEADER);
    first.flush(null, { status: 0, statusText: 'red' });

    api.saveDraft(input()).subscribe({ error: () => undefined });
    const retry = post();
    expect(retry.request.headers.get(IDEMPOTENCY_HEADER)).toBe(key);
    retry.flush(
      { id: 'r1', kind: 'SALE', status: 'BORRADOR', invoiceId: 'inv-1', lines: [], reason: '' },
      { status: 201, statusText: 'Created' },
    );

    api.saveDraft(input()).subscribe({ error: () => undefined });
    const next = post();
    expect(next.request.headers.get(IDEMPOTENCY_HEADER)).not.toBe(key);
    next.flush(null, { status: 500, statusText: 'x' });
  });

  it('un cuerpo distinto usa otra clave', () => {
    api.saveDraft(input()).subscribe({ error: () => undefined });
    const first = post();
    const key = first.request.headers.get(IDEMPOTENCY_HEADER);
    first.flush(null, { status: 0, statusText: 'red' });

    api.saveDraft(input({ lines: [{ productId: 'p1', cantidad: 2 }] })).subscribe({ error: () => undefined });
    const changed = post();
    expect(changed.request.headers.get(IDEMPOTENCY_HEADER)).not.toBe(key);
    changed.flush(null, { status: 500, statusText: 'x' });
  });
});
