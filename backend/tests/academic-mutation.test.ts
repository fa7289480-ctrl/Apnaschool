import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const { transaction, queryRaw, findUnique, auditWrite } = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findUnique: vi.fn(),
  auditWrite: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({ prisma: { $transaction: transaction } }));
vi.mock('../src/services/audit.js', () => ({ recordAuditStrict: auditWrite }));

import { SchoolStatus } from '@prisma/client';
import { withAcademicMutation } from '../src/services/academicMutation.js';

const tx = {
  $queryRaw: queryRaw,
  school: { findUnique },
};
const req = { ip: '127.0.0.1' } as Request;
const audit = { userId: 'principal-1', action: 'CLASS_CREATED', entity: 'Class' };

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
  queryRaw.mockResolvedValue([{ id: 'school-1' }]);
  findUnique.mockResolvedValue({ id: 'school-1', status: SchoolStatus.ACTIVE, trialEndsAt: null, planExpiresAt: new Date(Date.now() + 60_000) });
  auditWrite.mockResolvedValue(undefined);
});

describe('withAcademicMutation', () => {
  it('locks and rechecks the school before running the mutation and audit', async () => {
    const order: string[] = [];
    queryRaw.mockImplementation(async () => { order.push('lock'); return [{ id: 'school-1' }]; });
    findUnique.mockImplementation(async () => { order.push('lifecycle'); return { id: 'school-1', status: SchoolStatus.ACTIVE, trialEndsAt: null, planExpiresAt: new Date(Date.now() + 60_000) }; });
    auditWrite.mockImplementation(async () => { order.push('audit'); });

    const result = await withAcademicMutation(req, 'school-1', audit, async () => {
      order.push('mutation');
      return { result: 'created', entityId: 'class-1' };
    });

    expect(result).toBe('created');
    expect(order).toEqual(['lock', 'lifecycle', 'mutation', 'audit']);
    expect(auditWrite).toHaveBeenCalledWith(req, expect.objectContaining({ schoolId: 'school-1', entityId: 'class-1' }), tx);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: expect.any(String) }));
  });

  it.each([SchoolStatus.PENDING, SchoolStatus.EXPIRED, SchoolStatus.REJECTED, SchoolStatus.SUSPENDED])('rejects writes for %s schools', async (status) => {
    findUnique.mockResolvedValue({ id: 'school-1', status, trialEndsAt: null });
    const mutation = vi.fn(async () => ({ result: 'should-not-run' }));
    await expect(withAcademicMutation(req, 'school-1', audit, mutation)).rejects.toMatchObject({ statusCode: 403 });
    expect(mutation).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('rejects a trial that has expired according to server time', async () => {
    findUnique.mockResolvedValue({ id: 'school-1', status: SchoolStatus.TRIAL, trialEndsAt: new Date(Date.now() - 1) });
    await expect(withAcademicMutation(req, 'school-1', audit, async () => ({ result: 'no' }))).rejects.toMatchObject({ statusCode: 403 });
  });


  it('rejects academic writes after the paid plan expires even before a lifecycle status update', async () => {
    findUnique.mockResolvedValue({ id: 'school-1', status: SchoolStatus.ACTIVE, trialEndsAt: null, planExpiresAt: new Date(Date.now() - 1) });
    const mutation = vi.fn(async () => ({ result: 'no' }));
    await expect(withAcademicMutation(req, 'school-1', audit, mutation)).rejects.toMatchObject({ statusCode: 403 });
    expect(mutation).not.toHaveBeenCalled();
  });

  it('propagates audit failures so the Prisma transaction can roll back the mutation', async () => {
    auditWrite.mockRejectedValue(new Error('audit database unavailable'));
    await expect(withAcademicMutation(req, 'school-1', audit, async () => ({ result: 'created', entityId: 'class-1' }))).rejects.toThrow('audit database unavailable');
  });
});
