import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Subject, of } from 'rxjs';
import { SaleInvoice } from '../models/billing-sale-invoice.model';
import { SaleReturn } from '../models/billing-sale-return.model';
import { BillingCounterpartyCatalog } from '../services/billing-counterparty-catalog';
import { BillingProductCatalog } from '../services/billing-product-catalog';
import { BillingSaleInvoiceApi } from '../services/billing-sale-invoice.api';
import { BillingSaleReturnApi } from '../services/billing-sale-return.api';
import { SaleInvoiceFormComponent } from './sale-invoice-form/sale-invoice-form.component';
import { SaleReturnFormComponent } from './sale-return-form/sale-return-form.component';

// N llamadas rápidas (sin esperar a que termine la anterior) deben producir UNA sola petición
const CLICKS = 20;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const providersFor = (invoiceApi: unknown, returnApi: unknown) => [
  { provide: BillingSaleInvoiceApi, useValue: invoiceApi },
  { provide: BillingSaleReturnApi, useValue: returnApi },
  { provide: BillingProductCatalog, useValue: { getProducts: () => of([]) } },
  { provide: BillingCounterpartyCatalog, useValue: { getCounterparties: () => of([]) } },
  { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
  { provide: Location, useValue: { replaceState: () => undefined, back: () => undefined } },
  { provide: MessageService, useValue: { add: jasmine.createSpy('add') } },
  { provide: ActivatedRoute, useValue: { snapshot: { data: {}, paramMap: convertToParamMap({}) } } },
];

describe('Doble envío en el formulario de factura', () => {
  let invoiceApi: { saveDraft: jasmine.Spy; emit: jasmine.Spy; deleteDraft: jasmine.Spy };
  let component: SaleInvoiceFormComponent;
  let saveGate: Subject<SaleInvoice>;
  let emitGate: Subject<SaleInvoice>;
  let messages: { add: jasmine.Spy };

  const draft = { id: 'i1', kind: 'SALE', status: 'BORRADOR', number: null, lines: [], date: '2026-10-27', clientId: 'c1' } as unknown as SaleInvoice;

  beforeEach(() => {
    saveGate = new Subject<SaleInvoice>();
    emitGate = new Subject<SaleInvoice>();
    invoiceApi = {
      saveDraft: jasmine.createSpy('saveDraft').and.returnValue(saveGate),
      emit: jasmine.createSpy('emit').and.returnValue(emitGate),
      deleteDraft: jasmine.createSpy('deleteDraft').and.returnValue(of(undefined)),
    };
    TestBed.configureTestingModule({ providers: providersFor(invoiceApi, {}) });
    TestBed.overrideComponent(SaleInvoiceFormComponent, {
      set: { template: '', templateUrl: undefined, imports: [] },
    });
    component = TestBed.createComponent(SaleInvoiceFormComponent).componentInstance;
    messages = TestBed.inject(MessageService) as unknown as { add: jasmine.Spy };
    component.clientId.set('c1');
  });

  it('20 llamadas a saveDraft generan una sola petición', async () => {
    for (let i = 0; i < CLICKS; i++) void component.saveDraft();
    await flush();
    expect(invoiceApi.saveDraft).toHaveBeenCalledTimes(1);
    expect(component.busy()).toBeTrue();

    saveGate.next(draft);
    await flush();
    expect(invoiceApi.saveDraft).toHaveBeenCalledTimes(1);
    expect(component.busy()).toBeFalse(); // se libera al terminar
  });

  it('20 llamadas a emit generan un solo guardado y una sola emisión', async () => {
    component.invoiceId.set('i1');
    invoiceApi.saveDraft.and.returnValue(of(draft));
    const emit = (component as unknown as { emit: () => Promise<void> }).emit.bind(component);
    for (let i = 0; i < CLICKS; i++) void emit();
    await flush();
    expect(invoiceApi.emit).toHaveBeenCalledTimes(1);

    emitGate.next({ ...draft, status: 'EMITIDA', number: 'FV-1' });
    await flush();
    expect(invoiceApi.emit).toHaveBeenCalledTimes(1);
    expect(invoiceApi.saveDraft.calls.count()).toBeLessThanOrEqual(1);
  });

  it('un 409 BILLING_IDEMPOTENCY_CONFLICT muestra el mensaje de error', async () => {
    const { HttpErrorResponse } = await import('@angular/common/http');
    void component.saveDraft();
    await flush();
    saveGate.error(
      new HttpErrorResponse({ status: 409, error: { code: 'BILLING_IDEMPOTENCY_CONFLICT', message: 'x' } }),
    );
    await flush();
    const call = messages.add.calls.mostRecent().args[0];
    expect(call.severity).toBe('error');
    expect(call.detail).toContain('datos distintos');
    expect(component.busy()).toBeFalse();
  });
});

describe('Doble envío en el formulario de devolución', () => {
  let returnApi: { saveDraft: jasmine.Spy; emit: jasmine.Spy; annul: jasmine.Spy };
  let component: SaleReturnFormComponent;
  let gate: Subject<SaleReturn>;

  const saved = { id: 'r1', kind: 'SALE', status: 'BORRADOR', invoiceId: 'inv', lines: [], reason: 'x', date: '2026-10-27' } as unknown as SaleReturn;

  beforeEach(() => {
    gate = new Subject<SaleReturn>();
    returnApi = {
      saveDraft: jasmine.createSpy('saveDraft').and.returnValue(of(saved)),
      emit: jasmine.createSpy('emit').and.returnValue(gate),
      annul: jasmine.createSpy('annul').and.returnValue(gate),
    };
    TestBed.configureTestingModule({ providers: providersFor({}, returnApi) });
    TestBed.overrideComponent(SaleReturnFormComponent, {
      set: { template: '', templateUrl: undefined, imports: [] },
    });
    component = TestBed.createComponent(SaleReturnFormComponent).componentInstance;
    component.returnId.set('r1');
    component.reason.set('defecto');
  });

  it('20 llamadas a emit generan una sola emisión', async () => {
    const emit = (component as unknown as { emit: () => Promise<void> }).emit.bind(component);
    for (let i = 0; i < CLICKS; i++) void emit();
    await flush();
    expect(returnApi.emit).toHaveBeenCalledTimes(1);
    gate.next({ ...saved, status: 'EMITIDA' });
    await flush();
    expect(returnApi.emit).toHaveBeenCalledTimes(1);
  });

  it('20 llamadas a confirmAnnul generan una sola anulación', async () => {
    component.annulReasonText = 'motivo';
    for (let i = 0; i < CLICKS; i++) void component.confirmAnnul();
    await flush();
    expect(returnApi.annul).toHaveBeenCalledTimes(1);
    expect(component.annulling()).toBeTrue();
    gate.next({ ...saved, status: 'ANULADA' });
    await flush();
    expect(component.annulling()).toBeFalse();
  });
});
