/**
 * Sequential public identifiers for schools and users.
 * Format: PREFIX-NNNN (zero-padded, platform-wide uniqueness).
 * SCH / PRI / TCH / STU / PAR / ADM
 */
import type { Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type CodePrefix = 'SCH' | 'PRI' | 'TCH' | 'STU' | 'PAR' | 'ADM';

const ROLE_PREFIX: Partial<Record<Role, CodePrefix>> = {
  SUPER_ADMIN: 'ADM',
  SCHOOL_ADMIN: 'PRI',
  TEACHER: 'TCH',
  STUDENT: 'STU',
  PARENT: 'PAR',
};

function formatCode(prefix: CodePrefix, n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

function parseMax(codes: { publicCode: string | null }[], prefix: CodePrefix): number {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`, 'i');
  for (const row of codes) {
    const m = row.publicCode?.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/** Allocate next school public code (SCH-0001 …). Caller should run inside a transaction when possible. */
export async function nextSchoolPublicCode(
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  const rows = await tx.school.findMany({
    where: { publicCode: { not: null } },
    select: { publicCode: true },
    orderBy: { publicCode: 'desc' },
    take: 5000,
  });
  return formatCode('SCH', parseMax(rows, 'SCH') + 1);
}

/** Allocate next user public code for a role. */
export async function nextUserPublicCode(
  role: Role,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  const prefix = ROLE_PREFIX[role] ?? 'ADM';
  const rows = await tx.user.findMany({
    where: { publicCode: { startsWith: `${prefix}-` } },
    select: { publicCode: true },
    orderBy: { publicCode: 'desc' },
    take: 5000,
  });
  return formatCode(prefix, parseMax(rows, prefix) + 1);
}

/** Suggest a unique username from name + public code suffix. */
export function suggestUsername(firstName: string, publicCode: string): string {
  const base = firstName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20) || 'user';
  const suffix = publicCode.split('-')[1] || String(Date.now()).slice(-4);
  return `${base}${suffix}`;
}

export function rolePrefix(role: Role): CodePrefix {
  return ROLE_PREFIX[role] ?? 'ADM';
}
