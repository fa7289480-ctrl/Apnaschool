export type PaperState = 'DRAFT' | 'SUBMITTED' | 'REVISION_REQUESTED' | 'REJECTED' | 'APPROVED';
export type PaperDecision = 'APPROVED' | 'REJECTED' | 'REVISION_REQUESTED';
export type VoucherApproval = 'PENDING' | 'APPROVED' | 'REJECTED';

export function canEditPaper(state: PaperState): boolean {
  return state === 'DRAFT' || state === 'REJECTED' || state === 'REVISION_REQUESTED';
}

export function canSubmitPaper(state: PaperState): boolean {
  return canEditPaper(state);
}

export function paperStateForDecision(decision: PaperDecision): PaperState {
  if (decision === 'APPROVED') return 'APPROVED';
  if (decision === 'REJECTED') return 'REJECTED';
  return 'REVISION_REQUESTED';
}

export function canExportPaper(state: PaperState, approvedVersionId: string | null): boolean {
  return state === 'APPROVED' && Boolean(approvedVersionId);
}

export function canParentAccessVoucher(state: VoucherApproval): boolean {
  return state === 'APPROVED';
}

export function canApproveVoucher(state: VoucherApproval): boolean {
  return state === 'PENDING';
}

export function canResubmitVoucher(state: VoucherApproval): boolean {
  return state === 'REJECTED';
}

export function canRecordVoucherPayment(state: VoucherApproval): boolean {
  return state === 'APPROVED';
}
