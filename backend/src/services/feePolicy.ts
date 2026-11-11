/** Pure money rules used by fee endpoints and unit tests. Amounts are integer paisa internally. */
export interface FeeBalanceInput { amount: number; discountAmount: number; adjustmentAmount: number; payments: number[] }
export interface FeeBalance { total: number; paid: number; balance: number }
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100);
const rupees = (value: number) => Math.round(value) / 100;
export function calculateFeeBalance(input: FeeBalanceInput): FeeBalance {
  const totalCents = cents(input.amount) - cents(input.discountAmount) + cents(input.adjustmentAmount);
  const paidCents = input.payments.reduce((sum, payment) => sum + cents(payment), 0);
  if (totalCents < 0 || paidCents < 0) throw new Error('Fee totals cannot be negative');
  return { total: rupees(totalCents), paid: rupees(paidCents), balance: rupees(Math.max(0, totalCents - paidCents)) };
}
export function validateFeePayment(balance: number, payment: number): void {
  if (!Number.isFinite(payment) || payment <= 0 || Math.abs(payment * 100 - Math.round(payment * 100)) > 0.000001) throw new Error('Payment amount must be positive and have at most two decimal places');
  if (balance <= 0) throw new Error('Invoice has no outstanding balance');
  if (cents(payment) > cents(balance)) throw new Error('Payment exceeds outstanding balance');
}
export function validateFeeDiscount(balance: number, discount: number): void {
  if (!Number.isFinite(discount) || discount <= 0 || Math.abs(discount * 100 - Math.round(discount * 100)) > 0.000001) throw new Error('Discount amount must be positive and have at most two decimal places');
  if (cents(discount) > cents(balance)) throw new Error('Discount/concession cannot exceed the unpaid balance');
}

/** Explicit portal policy; school staff can manage fees, but teaching roles cannot. */
export function canManageSchoolFees(role: string): boolean { return role === 'SCHOOL_ADMIN'; }
export function canViewOwnFeeRecords(role: string): boolean { return role === 'PARENT' || role === 'STUDENT'; }
/** Scope always wins over caller-supplied filters, including a malicious schoolId field. */
export function schoolScopedFeeWhere<T extends Record<string, unknown>>(schoolId: string, filters: T): T & { schoolId: string } {
  return { ...filters, schoolId };
}
export function isDuplicateFeeReferenceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  const targetText = Array.isArray(target) ? target.join('_') : String(target ?? '');
  return targetText.toLowerCase().includes('reference');
}
