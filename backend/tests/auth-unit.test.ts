/**
 * Pure-unit tests for the auth building blocks. No Express app, no database.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

import {
  cookieSecure,
  corsOrigins,
  env,
  isCorsOriginAllowed,
} from '../src/config/env.js';
import { isOriginAllowed, requestOrigin } from '../src/middleware/csrf.js';
import { createAuthMiddleware, publicUser } from '../src/middleware/auth.js';
import {
  generateTempPassword,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/services/password.js';
import {
  generateToken,
  hashToken,
  randomToken,
  safeEqualHash,
} from '../src/services/token.js';

describe('environment parsing', () => {
  it('treats explicit "false" booleans as false (not JS truthiness)', () => {
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.SMTP_SECURE).toBe(false);
    expect(cookieSecure).toBe(false);
  });

  it('parses comma-separated CORS origins', () => {
    expect(corsOrigins).toEqual([
      'http://localhost:3000',
      'http://localhost:4173',
    ]);
  });
});

describe('token service', () => {
  it('generates URL-safe tokens and stores only a peppered hash', () => {
    const { token, tokenHash } = generateToken('pepper');

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toBe(hashToken(token, 'pepper'));
    expect(tokenHash).not.toBe(hashToken(token, 'different-pepper'));
  });

  it('generates unique tokens', () => {
    expect(randomToken()).not.toBe(randomToken());
  });

  it('compares hashes in constant time without throwing on length mismatch', () => {
    const a = hashToken('a', 'pepper');
    const b = hashToken('b', 'pepper');

    expect(safeEqualHash(a, a)).toBe(true);
    expect(safeEqualHash(a, b)).toBe(false);
    expect(safeEqualHash(a, 'ff')).toBe(false);
  });
});

describe('password service', () => {
  it('hashes with Argon2id and verifies only the right password', async () => {
    const hash = await hashPassword('Correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('generates readable temporary passwords of the requested length', () => {
    const temp = generateTempPassword(20);

    expect(temp).toHaveLength(20);
    expect(temp).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});

describe('CSRF origin checks', () => {
  it('uses the same exact local-origin policy as CORS for native clients', () => {
    expect(isCorsOriginAllowed('https://localhost')).toBe(true);
    expect(isCorsOriginAllowed('capacitor://localhost')).toBe(true);
    expect(isCorsOriginAllowed('http://10.0.2.2:3001')).toBe(true);
    expect(isCorsOriginAllowed('http://localhost:3000.evil.example')).toBe(false);
    expect(isCorsOriginAllowed('http://localhost:3000@evil.example')).toBe(false);
  });

  it('accepts only exact allow-listed origins', () => {
    expect(isOriginAllowed('http://localhost:3000', corsOrigins)).toBe(true);
    expect(isOriginAllowed('http://evil.example', corsOrigins)).toBe(false);
    expect(isOriginAllowed(null, corsOrigins)).toBe(false);
    expect(isOriginAllowed(undefined, corsOrigins)).toBe(false);
    expect(isOriginAllowed('http://localhost:3000.evil.example', corsOrigins)).toBe(false);
  });

  it('prefers Origin and falls back to the Referer origin', () => {
    const withOrigin = {
      get: (name: string) =>
        name === 'origin' ? 'http://localhost:3000' : 'http://ignored.example/page',
    } as unknown as Request;
    const withReferer = {
      get: (name: string) =>
        name === 'referer' ? 'http://localhost:4173/login.html?x=1' : undefined,
    } as unknown as Request;
    const invalidReferer = {
      get: (name: string) => (name === 'referer' ? 'not a url' : undefined),
    } as unknown as Request;

    expect(requestOrigin(withOrigin)).toBe('http://localhost:3000');
    expect(requestOrigin(withReferer)).toBe('http://localhost:4173');
    expect(requestOrigin(invalidReferer)).toBeNull();
  });
});

describe('auth middleware', () => {
  const authenticatedUser = {
    id: 'user_1',
    email: 'teacher@example.com',
    firstName: 'Tara',
    lastName: 'Teacher',
    role: 'TEACHER' as const,
    schoolId: 'school_1',
    mustChangePassword: false,
    emailVerifiedAt: new Date(),
  };

  it('rejects requests without a session', async () => {
    const { requireAuth } = createAuthMiddleware({ getSession: async () => null });
    const next = vi.fn();
    const req = {} as Request;

    await requireAuth(req, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
    expect(req.user).toBeUndefined();
  });

  it('attaches the authenticated user and session', async () => {
    const session = {
      id: 'session_1',
      token: 'hash',
      userId: authenticatedUser.id,
      expiresAt: new Date(Date.now() + 1_000_000),
    };
    const { requireAuth } = createAuthMiddleware({
      getSession: async () => ({ user: authenticatedUser, session }),
    });
    const next = vi.fn();
    const req = {} as Request;

    await requireAuth(req, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual(authenticatedUser);
    expect(req.session).toEqual(session);
  });

  it('enforces role checks explicitly (SUPER_ADMIN is not implicit)', () => {
    const { requireRole, requireSuperAdmin } = createAuthMiddleware({
      getSession: async () => null,
    });
    const req = { user: authenticatedUser } as Request;

    const teacherNext = vi.fn();
    requireRole('TEACHER')(req, {} as Response, teacherNext as NextFunction);
    expect(teacherNext).toHaveBeenCalledWith();

    const adminNext = vi.fn();
    requireRole('SUPER_ADMIN')(req, {} as Response, adminNext as NextFunction);
    expect(adminNext.mock.calls[0][0]).toMatchObject({ statusCode: 403 });

    const superNext = vi.fn();
    requireSuperAdmin(req, {} as Response, superNext as NextFunction);
    expect(superNext.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });
});

describe('publicUser', () => {
  it('returns a safe payload without the password hash', () => {
    const payload = publicUser({
      id: 'user_1',
      email: 'admin@example.com',
      firstName: 'Ada',
      lastName: 'Admin',
      role: 'SCHOOL_ADMIN',
      schoolId: 'school_1',
      mustChangePassword: true,
      emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
      passwordHash: '$argon2id$secret',
    } as never);

    expect(payload).toEqual({
      id: 'user_1',
      email: 'admin@example.com',
      firstName: 'Ada',
      lastName: 'Admin',
      role: 'SCHOOL_ADMIN',
      schoolId: 'school_1',
      mustChangePassword: true,
      emailVerified: true,
      publicCode: null,
      username: null,
    });
    expect(payload).not.toHaveProperty('passwordHash');
  });
});
