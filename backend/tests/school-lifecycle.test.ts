import { describe, expect, it } from 'vitest';
import { SchoolStatus } from '@prisma/client';
import { assertCanApprove, parseApprovalMode, parsePlanDurationDays, restoredStatus, trialEndFrom, TRIAL_DURATION_DAYS } from '../src/services/schoolLifecycle.js';

describe('school lifecycle policy', () => {
  it('defaults onboarding to approval-first when no setting exists', () => {
    expect(parseApprovalMode(undefined)).toBe('MANUAL');
    expect(parseApprovalMode(null)).toBe('MANUAL');
  });

  it('accepts only supported approval modes', () => {
    expect(parseApprovalMode('AUTOMATIC')).toBe('AUTOMATIC');
    expect(parseApprovalMode('MANUAL')).toBe('MANUAL');
    expect(() => parseApprovalMode('anything')).toThrow();
  });

  it('starts the fixed 15-day trial from the approval timestamp', () => {
    const start = new Date('2026-01-01T12:00:00.000Z');
    expect(TRIAL_DURATION_DAYS).toBe(15);
    expect(trialEndFrom(start).toISOString()).toBe('2026-01-16T12:00:00.000Z');
  });

  it('allows approval only from PENDING', () => {
    expect(() => assertCanApprove(SchoolStatus.PENDING)).not.toThrow();
    expect(() => assertCanApprove(SchoolStatus.TRIAL)).toThrow();
    expect(() => assertCanApprove(SchoolStatus.ACTIVE)).toThrow();
  });

  it('restores suspended schools to the strongest currently valid entitlement or read-only EXPIRED', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(restoredStatus({ trialEndsAt: new Date('2026-01-02T00:00:00.000Z'), planExpiresAt: null }, now)).toBe(SchoolStatus.TRIAL);
    expect(restoredStatus({ trialEndsAt: new Date('2026-01-02T00:00:00.000Z'), planExpiresAt: new Date('2026-02-01T00:00:00.000Z') }, now)).toBe(SchoolStatus.ACTIVE);
    expect(restoredStatus({ trialEndsAt: new Date('2025-12-31T00:00:00.000Z'), planExpiresAt: new Date('2026-02-01T00:00:00.000Z') }, now)).toBe(SchoolStatus.ACTIVE);
    expect(restoredStatus({ trialEndsAt: null, planExpiresAt: null }, now)).toBe(SchoolStatus.EXPIRED);
  });

  it('does not invent subscription durations', () => {
    expect(parsePlanDurationDays(undefined)).toBeNull();
    expect(parsePlanDurationDays('30')).toBe(30);
    expect(() => parsePlanDurationDays('0')).toThrow();
    expect(() => parsePlanDurationDays('abc')).toThrow();
    expect(() => parsePlanDurationDays('3661')).toThrow();
  });
});
