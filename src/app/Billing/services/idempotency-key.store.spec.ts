import { IdempotencyKeyStore } from './idempotency-key.store';

describe('IdempotencyKeyStore', () => {
  let store: IdempotencyKeyStore;

  beforeEach(() => (store = new IdempotencyKeyStore()));

  it('genera una clave con forma de UUID', () => {
    expect(store.keyFor('invoice:SALE', { a: 1 })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('reutiliza la clave mientras el ámbito y el cuerpo sean los mismos', () => {
    const first = store.keyFor('invoice:SALE', { a: 1 });
    expect(store.keyFor('invoice:SALE', { a: 1 })).toBe(first);
    expect(store.keyFor('invoice:SALE', { a: 1 })).toBe(first);
  });

  it('renueva la clave cuando el cuerpo cambia (otra intención)', () => {
    const first = store.keyFor('invoice:SALE', { a: 1 });
    expect(store.keyFor('invoice:SALE', { a: 2 })).not.toBe(first);
  });

  it('usa claves distintas por ámbito', () => {
    const sale = store.keyFor('invoice:SALE', { a: 1 });
    expect(store.keyFor('invoice:PURCHASE', { a: 1 })).not.toBe(sale);
  });

  it('release libera la clave: el siguiente intento con el mismo cuerpo usa una nueva', () => {
    const first = store.keyFor('invoice:SALE', { a: 1 });
    store.release('invoice:SALE', first);
    expect(store.keyFor('invoice:SALE', { a: 1 })).not.toBe(first);
  });

  it('release con una clave que ya no es la pendiente no borra la vigente', () => {
    const old = store.keyFor('invoice:SALE', { a: 1 });
    const current = store.keyFor('invoice:SALE', { a: 2 });
    store.release('invoice:SALE', old);
    expect(store.keyFor('invoice:SALE', { a: 2 })).toBe(current);
  });
});
