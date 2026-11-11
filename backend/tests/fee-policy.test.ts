import { describe, expect, it } from 'vitest';
import { calculateFeeBalance, validateFeeDiscount, validateFeePayment } from '../src/services/feePolicy.js';

describe('fee ledger money rules', () => {
  it('calculates full invoice totals and outstanding balance in cents', () => {
    expect(calculateFeeBalance({ amount: 1250, discountAmount: 50, adjustmentAmount: 0, payments: [1200] })).toEqual({ total: 1200, paid: 1200, balance: 0 });
  });
  it('handles partial payments without floating-point drift', () => {
    expect(calculateFeeBalance({ amount: 1000, discountAmount: 0, adjustmentAmount: 0, payments: [125.1, 300.2] })).toEqual({ total: 1000, paid: 425.3, balance: 574.7 });
  });
  it('rejects overpayment and payment against a settled invoice', () => {
    expect(() => validateFeePayment(100, 100.01)).toThrow(/exceeds outstanding/);
    expect(() => validateFeePayment(0, 1)).toThrow(/no outstanding/);
  });
  it('rejects zero, negative and fractions below a paisa', () => {
    expect(() => validateFeePayment(10, 0)).toThrow();
    expect(() => validateFeePayment(10, 1.001)).toThrow();
  });
  it('limits concessions to the outstanding balance', () => {
    expect(() => validateFeeDiscount(25, 25.01)).toThrow(/cannot exceed/);
    expect(() => validateFeeDiscount(25, 25)).not.toThrow();
  });
});

describe('fee authorization and tenant policy', () => {
  it('allows fee management only to School Admin, not teachers or Super Admin', async () => {
    const { canManageSchoolFees } = await import('../src/services/feePolicy.js');
    expect(canManageSchoolFees('SCHOOL_ADMIN')).toBe(true);
    expect(canManageSchoolFees('TEACHER')).toBe(false);
    expect(canManageSchoolFees('SUPER_ADMIN')).toBe(false);
  });
  it('allows own-fee portal access only for Parent and Student roles', async () => {
    const { canViewOwnFeeRecords } = await import('../src/services/feePolicy.js');
    expect(canViewOwnFeeRecords('PARENT')).toBe(true);
    expect(canViewOwnFeeRecords('STUDENT')).toBe(true);
    expect(canViewOwnFeeRecords('TEACHER')).toBe(false);
    expect(canViewOwnFeeRecords('SCHOOL_ADMIN')).toBe(false);
  });
  it('forces the authenticated school scope over any caller-supplied schoolId', async () => {
    const { schoolScopedFeeWhere } = await import('../src/services/feePolicy.js');
    expect(schoolScopedFeeWhere('school-session', { status: 'UNPAID', schoolId: 'attacker-school' })).toEqual({ status: 'UNPAID', schoolId: 'school-session' });
  });
  it('recognizes duplicate payment-reference database constraints only', async () => {
    const { isDuplicateFeeReferenceError } = await import('../src/services/feePolicy.js');
    expect(isDuplicateFeeReferenceError({ code: 'P2002', meta: { target: ['schoolId', 'reference'] } })).toBe(true);
    expect(isDuplicateFeeReferenceError({ code: 'P2002', meta: { target: ['challanNo'] } })).toBe(false);
    expect(isDuplicateFeeReferenceError({ code: 'P2025' })).toBe(false);
  });
});
