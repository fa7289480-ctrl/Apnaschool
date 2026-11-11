/**
 * Best-effort audit helper for legacy callers. Errors are logged and swallowed.
 * Use recordAuditStrict for mutations whose success requires an audit record;
 * pass the active transaction client when the audit must commit atomically.
 */

import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../middleware/requestLogger.js';

interface AuditInput {
  userId?: string | null;
  schoolId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function recordAudit(
  req: Request | null,
  input: AuditInput,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        schoolId: input.schoolId ?? null,
        action: input.action,
        entity: input.entity ?? null,
        entityId: input.entityId ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
        ipAddress: req?.ip ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'audit log write failed');
  }
}

/** Strict variant for operations whose success response must not imply that the audit write succeeded. */
export async function recordAuditStrict(
  req: Request | null,
  input: AuditInput,
  client: Pick<Prisma.TransactionClient, 'auditLog'> = prisma,
): Promise<void> {
  await client.auditLog.create({
    data: {
      userId: input.userId ?? null,
      schoolId: input.schoolId ?? null,
      action: input.action,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
      ipAddress: req?.ip ?? null,
    },
  });
}
