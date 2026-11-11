import { describe, expect, it } from 'vitest';
import { canApproveVoucher, canEditPaper, canExportPaper, canParentAccessVoucher, canRecordVoucherPayment, canResubmitVoucher, canSubmitPaper, paperStateForDecision } from '../src/services/approvalPolicy.js';

describe('question paper approval policy', () => {
  it('permits teachers to edit and resubmit returned work only', () => {
    expect(canEditPaper('DRAFT')).toBe(true);
    expect(canEditPaper('REJECTED')).toBe(true);
    expect(canEditPaper('REVISION_REQUESTED')).toBe(true);
    expect(canEditPaper('SUBMITTED')).toBe(false);
    expect(canEditPaper('APPROVED')).toBe(false);
    expect(canSubmitPaper('APPROVED')).toBe(false);
  });

  it('maps Principal decisions to terminal review states and locks export until approval', () => {
    expect(paperStateForDecision('APPROVED')).toBe('APPROVED');
    expect(paperStateForDecision('REJECTED')).toBe('REJECTED');
    expect(paperStateForDecision('REVISION_REQUESTED')).toBe('REVISION_REQUESTED');
    expect(canExportPaper('SUBMITTED', null)).toBe(false);
    expect(canExportPaper('APPROVED', null)).toBe(false);
    expect(canExportPaper('APPROVED', 'version-1')).toBe(true);
  });
});

describe('fee voucher approval policy', () => {
  it('keeps pending and rejected vouchers from parents and payment processing', () => {
    for (const state of ['PENDING', 'REJECTED'] as const) {
      expect(canParentAccessVoucher(state)).toBe(false);
      expect(canRecordVoucherPayment(state)).toBe(false);
    }
    expect(canParentAccessVoucher('APPROVED')).toBe(true);
    expect(canRecordVoucherPayment('APPROVED')).toBe(true);
  });

  it('allows only the matching Principal action for each voucher state', () => {
    expect(canApproveVoucher('PENDING')).toBe(true);
    expect(canApproveVoucher('APPROVED')).toBe(false);
    expect(canApproveVoucher('REJECTED')).toBe(false);
    expect(canResubmitVoucher('REJECTED')).toBe(true);
    expect(canResubmitVoucher('PENDING')).toBe(false);
  });
});
