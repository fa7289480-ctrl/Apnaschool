import { Prisma, SchoolStatus } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../lib/prisma.js';
import { forbidden } from '../middleware/errorHandler.js';
import { recordAuditStrict } from './audit.js';

/**
 * Serializes academic writes against school lifecycle changes by locking the
 * school row. The data mutation and required audit event commit or roll back
 * together. Keep relation validation and all writes inside `work`.
 */
export async function withAcademicMutation<T>(
  req: Request,
  schoolId: string,
  audit: { userId: string; action: string; entity: string; entityId?: string | null; metadata?: Prisma.InputJsonValue },
  work: (tx: Prisma.TransactionClient) => Promise<{ result: T; entityId?: string | null }>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${schoolId} FOR UPDATE`;
    const school = await tx.school.findUnique({
      where: { id: schoolId },
      select: { id: true, status: true, trialEndsAt: true, planExpiresAt: true },
    });
    if (!school) throw forbidden('School access is unavailable');
    const trialExpired = school.status === SchoolStatus.TRIAL &&
      (!school.trialEndsAt || school.trialEndsAt.getTime() <= Date.now());
    const paidPlanExpired = school.status === SchoolStatus.ACTIVE &&
      (!school.planExpiresAt || school.planExpiresAt.getTime() <= Date.now());
    const schoolCannotWrite =
      school.status === SchoolStatus.PENDING ||
      school.status === SchoolStatus.REJECTED ||
      school.status === SchoolStatus.SUSPENDED ||
      school.status === SchoolStatus.EXPIRED;
    if (schoolCannotWrite || trialExpired || paidPlanExpired) {
      throw forbidden('This school is not currently permitted to change academic data');
    }
    const { result, entityId } = await work(tx);
    await recordAuditStrict(req, {
      ...audit,
      schoolId,
      entityId: entityId ?? audit.entityId ?? null,
    }, tx);
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
