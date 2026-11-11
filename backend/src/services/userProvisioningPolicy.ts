import { Role, SchoolStatus } from '@prisma/client';
import { conflict, forbidden } from '../middleware/errorHandler.js';

export interface ProvisioningPolicyInput {
  callerRole: Role;
  targetRole: Role;
  schoolStatus: SchoolStatus;
  trialEndsAt: Date | null;
  planExpiresAt?: Date | null;
  existingPrincipal: boolean;
  now?: number;
}

/**
 * Enforce provisioning policy using server-loaded school state.
 * PENDING is limited to Super Admin initial-Principal onboarding. TRIAL must
 * have a future end date. EXPIRED/REJECTED/SUSPENDED are never provisionable.
 */
export function assertUserProvisioningAllowed(input: ProvisioningPolicyInput): void {
  const now = input.now ?? Date.now();
  const validTrial = input.schoolStatus === SchoolStatus.TRIAL &&
    input.trialEndsAt !== null && input.trialEndsAt.getTime() > now;
  const activeSchool = (input.schoolStatus === SchoolStatus.ACTIVE && input.planExpiresAt != null && input.planExpiresAt.getTime() > now) || validTrial;
  const initialPrincipal = input.callerRole === Role.SUPER_ADMIN &&
    input.targetRole === Role.SCHOOL_ADMIN && input.schoolStatus === SchoolStatus.PENDING;

  if (!activeSchool && !initialPrincipal) {
    throw forbidden('This school is not permitted to provision users in its current status');
  }

  if (input.targetRole === Role.SCHOOL_ADMIN) {
    if (input.callerRole !== Role.SUPER_ADMIN) {
      throw forbidden('Only a Super Admin can provision a school Principal');
    }
    if (input.schoolStatus !== SchoolStatus.PENDING) {
      throw forbidden('A Principal can only be provisioned through initial school onboarding');
    }
    if (input.existingPrincipal) throw conflict('This school already has a Principal');
  }
}
