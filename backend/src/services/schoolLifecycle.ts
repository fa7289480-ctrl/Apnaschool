import { SchoolStatus } from '@prisma/client';
import { badRequest, conflict } from '../middleware/errorHandler.js';

export const TRIAL_DURATION_DAYS = 15;

export type ApprovalMode = 'MANUAL' | 'AUTOMATIC';

export function parseApprovalMode(value: string | undefined | null): ApprovalMode {
  if (!value) return 'MANUAL';
  if (value === 'MANUAL' || value === 'AUTOMATIC') return value;
  throw badRequest('Stored school approval mode is invalid; correct the platform setting before changing onboarding');
}

export function trialEndFrom(start: Date): Date {
  return new Date(start.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
}

export function assertCanApprove(status: SchoolStatus): void {
  if (status !== SchoolStatus.PENDING) throw conflict('Only pending schools can be approved');
}

export function restoredStatus(input: {
  trialEndsAt: Date | null;
  planExpiresAt: Date | null;
}, now = new Date()): SchoolStatus {
  if (input.planExpiresAt && input.planExpiresAt.getTime() > now.getTime()) return SchoolStatus.ACTIVE;
  if (input.trialEndsAt && input.trialEndsAt.getTime() > now.getTime()) return SchoolStatus.TRIAL;
  return SchoolStatus.EXPIRED;
}

export function parsePlanDurationDays(value: string | undefined | null): number | null {
  if (value == null || value.trim() === '') return null;
  if (!/^\d+$/.test(value)) throw badRequest('Plan duration must be a whole number of days');
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3660) {
    throw badRequest('Plan duration must be between 1 and 3660 days');
  }
  return days;
}
