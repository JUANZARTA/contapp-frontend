import { HttpErrorResponse } from '@angular/common/http';

export const IDEMPOTENCY_CONFLICT_CODE = 'BILLING_IDEMPOTENCY_CONFLICT';

// Mensaje legible para el toast a partir del error del back (BillingErrorResponse: { code, message })
export const billingErrorMessage = (e: unknown): string => {
  if (e instanceof HttpErrorResponse) {
    const body = e.error as { code?: string; message?: string } | null;
    if (body?.code === IDEMPOTENCY_CONFLICT_CODE) {
      return 'Esta operación ya se envió con datos distintos. Recarga la pantalla e inténtalo de nuevo.';
    }
    if (body?.message) return body.message;
  }
  return e instanceof Error ? e.message : 'Ocurrió un error inesperado.';
};
