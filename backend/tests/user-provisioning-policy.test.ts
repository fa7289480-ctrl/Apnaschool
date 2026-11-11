import { describe, expect, it } from 'vitest';
import { Role, SchoolStatus } from '@prisma/client';
import { assertUserProvisioningAllowed } from '../src/services/userProvisioningPolicy.js';

const future = new Date(Date.now() + 60_000);
const past = new Date(Date.now() - 60_000);
const planFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);

function policy(overrides: Partial<Parameters<typeof assertUserProvisioningAllowed>[0]> = {}) {
  return assertUserProvisioningAllowed({
    callerRole: Role.SCHOOL_ADMIN,
    targetRole: Role.TEACHER,
    schoolStatus: SchoolStatus.ACTIVE,
    trialEndsAt: null,
    planExpiresAt: planFuture,
    existingPrincipal: false,
    ...overrides,
  });
}

describe('user provisioning lifecycle policy', () => {
  it('allows staff provisioning for ACTIVE schools', () => expect(policy()).toBeUndefined());
  it('allows staff provisioning for a valid TRIAL', () => expect(policy({ schoolStatus: SchoolStatus.TRIAL, trialEndsAt: future })).toBeUndefined());
  it.each([SchoolStatus.PENDING, SchoolStatus.EXPIRED, SchoolStatus.REJECTED, SchoolStatus.SUSPENDED])(
    'blocks staff provisioning for %s schools', (schoolStatus) => {
      expect(() => policy({ schoolStatus, trialEndsAt: null })).toThrow();
    },
  );
  it('blocks an expired or missing trial end date and missing/expired paid-plan expiry', () => {
    expect(() => policy({ schoolStatus: SchoolStatus.TRIAL, trialEndsAt: past })).toThrow();
    expect(() => policy({ schoolStatus: SchoolStatus.TRIAL, trialEndsAt: null })).toThrow();
    expect(() => policy({ schoolStatus: SchoolStatus.ACTIVE, planExpiresAt: null })).toThrow();
    expect(() => policy({ schoolStatus: SchoolStatus.ACTIVE, planExpiresAt: past })).toThrow();
  });
  it('only permits Super Admin initial Principal provisioning for a PENDING school with no Principal', () => {
    expect(policy({ callerRole: Role.SUPER_ADMIN, targetRole: Role.SCHOOL_ADMIN, schoolStatus: SchoolStatus.PENDING })).toBeUndefined();
    expect(() => policy({ targetRole: Role.SCHOOL_ADMIN })).toThrow();
    expect(() => policy({ callerRole: Role.SUPER_ADMIN, targetRole: Role.SCHOOL_ADMIN, schoolStatus: SchoolStatus.PENDING, existingPrincipal: true })).toThrow();
    expect(() => policy({ callerRole: Role.SUPER_ADMIN, targetRole: Role.SCHOOL_ADMIN, schoolStatus: SchoolStatus.ACTIVE })).toThrow();
  });
  it('uses the supplied server timestamp for trial expiry decisions', () => {
    expect(policy({ schoolStatus: SchoolStatus.TRIAL, trialEndsAt: new Date(5_000), now: 4_999 })).toBeUndefined();
    expect(() => policy({ schoolStatus: SchoolStatus.TRIAL, trialEndsAt: new Date(5_000), now: 5_000 })).toThrow();
  });
});
