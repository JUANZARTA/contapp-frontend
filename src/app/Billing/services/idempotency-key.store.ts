import { Injectable } from '@angular/core';

interface PendingKey {
  fingerprint: string;
  key: string;
}

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

const newKey = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

// Guarda la clave de idempotencia del intento de creación en curso, por ámbito (p. ej. 'invoice:SALE').
// - Mismo ámbito + mismo cuerpo => misma clave (doble clic o reintento por red: el back devuelve el mismo documento).
// - Cuerpo distinto => otra intención => clave nueva (si no, el back respondería 409 BILLING_IDEMPOTENCY_CONFLICT).
// - Al tener éxito la creación se libera (`release`) y el siguiente intento usa una clave nueva.
@Injectable({ providedIn: 'root' })
export class IdempotencyKeyStore {
  private readonly pending = new Map<string, PendingKey>();

  keyFor(scope: string, body: unknown): string {
    const fingerprint = JSON.stringify(body);
    const current = this.pending.get(scope);
    if (current && current.fingerprint === fingerprint) return current.key;
    const created = { fingerprint, key: newKey() };
    this.pending.set(scope, created);
    return created.key;
  }

  /** Libera la clave pendiente del ámbito (creación exitosa). Solo si sigue siendo la misma clave. */
  release(scope: string, key: string): void {
    if (this.pending.get(scope)?.key === key) this.pending.delete(scope);
  }
}
