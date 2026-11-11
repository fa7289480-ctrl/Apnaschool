import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('../src/lib/prisma.js', () => ({ prisma: { school: { findUnique } } }));

import { schoolIsolation } from '../src/middleware/schoolIsolation.js';

function runGuard(user: Record<string, unknown> | undefined, writes = false) {
  const req = { user } as unknown as Request;
  const res = {} as Response;
  let nextError: unknown;
  const next = ((error?: unknown) => { nextError = error; }) as NextFunction;
  return Promise.resolve(schoolIsolation({ writes })(req, res, next)).then(() => ({ req, nextError }));
}

beforeEach(() => findUnique.mockReset());

describe('schoolIsolation', () => {
  it('rejects requests without a session user', async () => {
    const result = await runGuard(undefined);
    expect(result.nextError).toMatchObject({ statusCode: 401 });
  });
  it('rejects users without a server-authorized school', async () => {
    const result = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: null });
    expect(result.nextError).toMatchObject({ statusCode: 403 });
    expect(findUnique).not.toHaveBeenCalled();
  });
  it.each(['PENDING', 'REJECTED', 'SUSPENDED'])('blocks protected data for %s schools', async (status) => {
    findUnique.mockResolvedValue({ id: 'school-a', status, trialEndsAt: null });
    const result = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: 'school-a' });
    expect(result.nextError).toMatchObject({ statusCode: 403 });
  });
  it.each(['ACTIVE', 'TRIAL'])('allows academic access for eligible %s schools', async (status) => {
    findUnique.mockResolvedValue({
      id: 'school-a',
      status,
      trialEndsAt: status === 'TRIAL' ? new Date(Date.now() + 60_000) : null,
      planExpiresAt: status === 'ACTIVE' ? new Date(Date.now() + 60_000) : null,
    });
    const result = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: 'school-a' });
    expect(result.nextError).toBeUndefined();
    expect((result.req as Request).schoolAccess).toMatchObject({ schoolId: 'school-a', readOnly: false });
  });
  it('uses server time to reject an expired trial for writes', async () => {
    findUnique.mockResolvedValue({ id: 'school-a', status: 'TRIAL', trialEndsAt: new Date(Date.now() - 1_000) });
    const result = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: 'school-a' }, true);
    expect(result.nextError).toMatchObject({ statusCode: 403 });
  });
  it('permits expired schools to read but rejects writes', async () => {
    findUnique.mockResolvedValue({ id: 'school-a', status: 'EXPIRED', trialEndsAt: null });
    const read = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: 'school-a' });
    expect(read.nextError).toBeUndefined();
    expect((read.req as Request).schoolAccess).toMatchObject({ schoolId: 'school-a', readOnly: true });
    const write = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: 'school-a' }, true);
    expect(write.nextError).toMatchObject({ statusCode: 403 });
  });
  it('treats a trial with no end date or a past end date as read-only', async () => {
    findUnique.mockResolvedValue({ id: 'school-a', status: 'TRIAL', trialEndsAt: null });
    const result = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: 'school-a' }, true);
    expect(result.nextError).toMatchObject({ statusCode: 403 });
  });

  it('treats an expired paid plan as read-only even if its status has not yet been transitioned', async () => {
    findUnique.mockResolvedValue({ id: 'school-a', status: 'ACTIVE', trialEndsAt: null, planExpiresAt: new Date(Date.now() - 1_000) });
    const read = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: 'school-a' });
    expect(read.nextError).toBeUndefined();
    expect((read.req as Request).schoolAccess).toMatchObject({ schoolId: 'school-a', readOnly: true });
    const write = await runGuard({ id: 'u1', role: 'SCHOOL_ADMIN', schoolId: 'school-a' }, true);
    expect(write.nextError).toMatchObject({ statusCode: 403 });
  });

  it('does not allow the generic academic middleware to become a Super Admin tenant bypass', async () => {
    const result = await runGuard({ id: 'root', role: 'SUPER_ADMIN', schoolId: null });
    expect(result.nextError).toMatchObject({ statusCode: 403 });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
