/**
 * Auth integration tests.
 *
 * These drive the real Express app through supertest. The Prisma client is
 * replaced with the in-memory double in tests/fake-prisma.ts, so the suite
 * exercises route validation, Argon2 password hashing, opaque session tokens,
 * cookies, RBAC, email-token flows and audit writes without a live database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Response as SupertestResponse } from 'supertest';

vi.mock('../src/lib/prisma.js', async () => {
  const { fakePrisma } = await import('./fake-prisma.js');
  return { prisma: fakePrisma };
});

import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { clearSentEmails, sentEmails } from '../src/services/email.js';
import * as emailService from '../src/services/email.js';
import { hashPassword, verifyPassword } from '../src/services/password.js';
import { hashToken } from '../src/services/token.js';
import { fakePrisma } from './fake-prisma.js';

const app = createApp();

const DEFAULT_PASSWORD = 'Sup3rSecret!';
const NEW_PASSWORD = 'An0therSecret!';

function uniqueEmail(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}@example.com`;
}

async function signUp(
  overrides: Record<string, unknown> = {},
): Promise<{ email: string; password: string }> {
  const email = uniqueEmail('admin');
  const password = DEFAULT_PASSWORD;
  await request(app)
    .post('/api/auth/signup')
    .send({
      schoolName: 'Bright Future School',
      firstName: 'Ada',
      lastName: 'Admin',
      email,
      password,
      ...overrides,
    })
    .expect(201);

  // Complete the real verification flow. Login now correctly rejects an
  // unverified account, so tests using this helper must not bypass that gate.
  await request(app)
    .post('/api/auth/verify-email')
    .send({ token: tokenFromLastEmail(email) })
    .expect(200);

  return { email, password };
}

function emailTo(address: string) {
  const messages = sentEmails.filter((message) => message.to === address);
  if (messages.length === 0) throw new Error(`No email captured for ${address}`);
  return messages[messages.length - 1];
}

function tokenFromLastEmail(address: string): string {
  const message = emailTo(address);
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (!match) throw new Error('No token found in captured email');
  return match[1];
}

function setCookies(response: SupertestResponse): string[] {
  const raw = response.headers['set-cookie'] as unknown;
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

function sessionCookie(response: SupertestResponse): string {
  const cookie = setCookies(response).find((value) =>
    value.startsWith(`${env.SESSION_COOKIE_NAME}=`),
  );
  if (!cookie) throw new Error('Session cookie was not set');
  return cookie;
}

beforeEach(() => {
  fakePrisma.__reset();
  clearSentEmails();
});

function addRoleSession(role: 'SUPER_ADMIN' | 'SCHOOL_ADMIN' | 'TEACHER' | 'PARENT' | 'STUDENT') {
  const userId = `policy-${role}`;
  const token = `policy-session-${role}`;
  const schoolId = role === 'SUPER_ADMIN' ? null : 'policy-school';
  const store = fakePrisma.__store();

  if (schoolId && !store.schools.some((school) => school.id === schoolId)) {
    store.schools.push({
      id: schoolId,
      status: 'ACTIVE',
      trialEndsAt: null,
      planExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  }

  store.users.push({
    id: userId,
    email: `${role.toLowerCase()}@example.com`,
    firstName: role,
    lastName: 'Policy',
    role,
    schoolId,
    isActive: true,
    mustChangePassword: false,
    emailVerifiedAt: new Date(),
  });
  store.sessions.push({
    id: `session-${role}`,
    userId,
    token: hashToken(token, env.SESSION_SECRET),
    expiresAt: new Date(Date.now() + 60_000),
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
  });

  return `${env.SESSION_COOKIE_NAME}=${token}`;
}

describe('strict audit rollback in the disposable test double', () => {
  it('rolls back initial signup records when the required audit write fails', async () => {
    fakePrisma.__setAuditFailure(true);
    const email = uniqueEmail('audit-fail-signup');
    await request(app).post('/api/auth/signup').send({
      schoolName: 'Audit Failure School', firstName: 'Test', lastName: 'Admin', email, password: DEFAULT_PASSWORD,
    }).expect(500);
    expect(fakePrisma.__store().schools).toHaveLength(0);
    expect(fakePrisma.__findUserByEmail(email)).toBeNull();
    expect(fakePrisma.__store().auditLogs).toHaveLength(0);
  });
});

describe('attendance and fee route role permissions', () => {
  it.each([
    ['SUPER_ADMIN', 400],
    ['SCHOOL_ADMIN', 403],
    ['TEACHER', 403],
    ['PARENT', 403],
    ['STUDENT', 403],
  ] as const)('checks Super Admin dashboard API access for %s', async (role, expectedStatus) => {
    const cookie = addRoleSession(role);
    const response = await request(app)
      .get('/api/admin/overview?months=invalid')
      .set('Cookie', cookie)
      .expect(expectedStatus);

    if (expectedStatus === 403) {
      expect(response.body.error.code).toBe('FORBIDDEN');
    } else {
      expect(response.body.error.code).not.toBe('FORBIDDEN');
    }
  });

  it.each([
    ['SUPER_ADMIN', 403],
    ['SCHOOL_ADMIN', 404],
    ['TEACHER', 404],
    ['PARENT', 403],
    ['STUDENT', 403],
  ] as const)('checks attendance route access for %s', async (role, expectedStatus) => {
    const cookie = addRoleSession(role);
    const response = await request(app)
      .get('/api/attendance/?classId=missing-class&date=2026-11-10')
      .set('Cookie', cookie)
      .expect(expectedStatus);

    if (expectedStatus === 403) {
      expect(response.body.error.code).toBe('FORBIDDEN');
    } else {
      expect(response.body.error.message).toBe('Class not found');
    }
  });

  it.each(['SUPER_ADMIN', 'TEACHER', 'PARENT', 'STUDENT'] as const)(
    'denies %s access to school fee management endpoints',
    async (role) => {
      const cookie = addRoleSession(role);
      await request(app)
        .get('/api/fees/categories')
        .set('Cookie', cookie)
        .expect(403);
    },
  );

  it.each([
    ['SUPER_ADMIN', 403],
    ['SCHOOL_ADMIN', 400],
    ['TEACHER', 400],
    ['PARENT', 403],
    ['STUDENT', 403],
  ] as const)('checks attendance write access for %s', async (role, expectedStatus) => {
    const cookie = addRoleSession(role);
    const response = await request(app)
      .post('/api/attendance/bulk')
      .set('Cookie', cookie)
      .send({})
      .expect(expectedStatus);

    if (expectedStatus === 403) {
      expect(response.body.error.code).toBe('FORBIDDEN');
    } else {
      expect(response.body.error.code).not.toBe('FORBIDDEN');
    }
  });

  it.each([
    ['SUPER_ADMIN', 403],
    ['SCHOOL_ADMIN', 400],
    ['TEACHER', 403],
    ['PARENT', 403],
    ['STUDENT', 403],
  ] as const)('checks fee-management write access for %s', async (role, expectedStatus) => {
    const cookie = addRoleSession(role);
    const response = await request(app)
      .post('/api/fees/categories')
      .set('Cookie', cookie)
      .send({})
      .expect(expectedStatus);

    if (expectedStatus === 403) {
      expect(response.body.error.code).toBe('FORBIDDEN');
    } else {
      expect(response.body.error.code).not.toBe('FORBIDDEN');
    }
  });

  it.each(['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER'] as const)(
    'denies %s access to personal fee records',
    async (role) => {
      const cookie = addRoleSession(role);
      await request(app)
        .get('/api/fees/my')
        .set('Cookie', cookie)
        .expect(403);
    },
  );

  it.each(['PARENT', 'STUDENT'] as const)(
    'allows %s to reach only its own personal fee lookup',
    async (role) => {
      const cookie = addRoleSession(role);
      const response = await request(app)
        .get('/api/fees/my')
        .set('Cookie', cookie)
        .expect(404);

      expect(response.body.error.message).toMatch(
        role === 'PARENT' ? /guardian profile/i : /active student record/i,
      );
    },
  );
});

describe('signup, verification, login and logout', () => {
  it('completes the full account lifecycle with secure session cookies', async () => {
    const email = uniqueEmail('owner').toUpperCase();
    const normalizedEmail = email.toLowerCase();

    const signup = await request(app)
      .post('/api/auth/signup')
      .send({
        schoolName: '  Bright Future School  ',
        firstName: ' Ada ',
        lastName: ' Admin ',
        email: `  ${email}  `,
        password: DEFAULT_PASSWORD,
      })
      .expect(201);

    expect(signup.body.message).toMatch(/check your email/i);
    expect(fakePrisma.__store().schools).toHaveLength(1);
    expect(fakePrisma.__store().schools[0].status).toBe('PENDING');

    const user = fakePrisma.__findUserByEmail(normalizedEmail);
    expect(user).not.toBeNull();
    expect(user.schoolId).toBe(fakePrisma.__store().schools[0].id);
    expect(user.role).toBe('SCHOOL_ADMIN');
    expect(user.passwordHash).not.toBe(DEFAULT_PASSWORD);
    expect(user.emailVerifiedAt).toBeNull();

    const verificationToken = tokenFromLastEmail(normalizedEmail);
    const storedVerification = fakePrisma.__tokensFor(user.id, 'EMAIL_VERIFICATION');
    expect(storedVerification).toHaveLength(1);
    expect(storedVerification[0].tokenHash).not.toBe(verificationToken);

    // Correct credentials are not sufficient until the email is verified.
    const unverifiedLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: normalizedEmail, password: DEFAULT_PASSWORD })
      .expect(403);
    expect(unverifiedLogin.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(fakePrisma.__sessionsFor(user.id)).toHaveLength(0);

    await request(app)
      .post('/api/auth/verify-email')
      .send({ token: verificationToken })
      .expect(200);
    expect(fakePrisma.__findUserByEmail(normalizedEmail).emailVerifiedAt).toBeInstanceOf(Date);

    // Tokens are single-use.
    await request(app)
      .post('/api/auth/verify-email')
      .send({ token: verificationToken })
      .expect(400);

    await request(app)
      .get('/api/auth/me')
      .expect(401);

    await request(app)
      .post('/api/auth/login')
      .send({ email: normalizedEmail, password: 'not-the-password' })
      .expect(401);
    expect(fakePrisma.__findUserByEmail(normalizedEmail).failedLoginAttempts).toBe(1);

    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ email: normalizedEmail, password: DEFAULT_PASSWORD, remember: false })
      .expect(200);

    expect(login.body.user).toMatchObject({
      email: normalizedEmail,
      role: 'SCHOOL_ADMIN',
      emailVerified: true,
      mustChangePassword: false,
    });
    expect(login.body.user).not.toHaveProperty('passwordHash');
    expect(login.body.session.id).toBeTruthy();
    expect(login.body.session.expiresAt).toBeTruthy();
    expect(login.body).not.toHaveProperty('token');

    const cookie = sessionCookie(login);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/Max-Age=604800/);
    expect(fakePrisma.__findUserByEmail(normalizedEmail).failedLoginAttempts).toBe(0);
    expect(fakePrisma.__findUserByEmail(normalizedEmail).lastLoginAt).toBeInstanceOf(Date);
    expect(fakePrisma.__sessionsFor(user.id)).toHaveLength(1);

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user.email).toBe(normalizedEmail);
    expect(me.body.user).not.toHaveProperty('passwordHash');

    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
    expect(fakePrisma.__sessionsFor(user.id)).toHaveLength(0);
  });

  it('issues a bearer token only to native clients and accepts it for the same account', async () => {
    const preflight = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://localhost')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-apnaschool-client')
      .expect(204);
    expect(preflight.headers['access-control-allow-headers']).toContain(
      'X-ApnaSchool-Client',
    );

    const { email, password } = await signUp();
    const login = await request(app)
      .post('/api/auth/login')
      .set('X-ApnaSchool-Client', 'native')
      .send({ email, password })
      .expect(200);

    expect(login.body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    const currentUser = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);

    expect(currentUser.body.user.email).toBe(email);
  });

  it('allows an unverified user to request a verification email without an authenticated session', async () => {
    const email = uniqueEmail('resend-verification');
    await request(app).post('/api/auth/signup').send({
      schoolName: 'Resend School', firstName: 'Verify', lastName: 'User', email, password: DEFAULT_PASSWORD,
    }).expect(201);
    const user = fakePrisma.__findUserByEmail(email);
    const previousToken = fakePrisma.__tokensFor(user.id, 'EMAIL_VERIFICATION')[0];
    clearSentEmails();

    const response = await request(app).post('/api/auth/resend-verification').send({ email }).expect(202);
    expect(response.body.message).toMatch(/if an unverified account exists/i);
    const currentTokens = fakePrisma.__tokensFor(user.id, 'EMAIL_VERIFICATION');
    expect(currentTokens).toHaveLength(2);
    expect(currentTokens.map((token) => token.tokenHash)).toContain(previousToken.tokenHash);
    expect(currentTokens.some((token) => token.tokenHash !== previousToken.tokenHash)).toBe(true);
    expect(sentEmails.some((message) => message.to === email)).toBe(true);
  });

  it('returns the same generic response for unknown and already verified addresses', async () => {
    const unknown = await request(app).post('/api/auth/resend-verification').send({ email: uniqueEmail('unknown') }).expect(202);
    const { email } = await signUp();
    const verified = await request(app).post('/api/auth/resend-verification').send({ email }).expect(202);
    expect(unknown.body).toEqual(verified.body);
  });

  it('preserves a previously delivered verification token when resend delivery fails', async () => {
    const email = uniqueEmail('resend-failure');
    await request(app).post('/api/auth/signup').send({
      schoolName: 'Resend Failure School', firstName: 'Verify', lastName: 'User', email, password: DEFAULT_PASSWORD,
    }).expect(201);
    const user = fakePrisma.__findUserByEmail(email);
    const previousToken = fakePrisma.__tokensFor(user.id, 'EMAIL_VERIFICATION')[0];
    vi.spyOn(emailService, 'sendVerificationEmail').mockRejectedValueOnce(new Error('simulated SMTP failure'));

    await request(app).post('/api/auth/resend-verification').send({ email }).expect(202);

    const remainingTokens = fakePrisma.__tokensFor(user.id, 'EMAIL_VERIFICATION');
    expect(remainingTokens).toHaveLength(1);
    expect(remainingTokens[0].id).toBe(previousToken.id);
    expect(remainingTokens[0].tokenHash).toBe(previousToken.tokenHash);
  });

  it('uses the longer remember-me session lifetime when requested', async () => {
    const { email, password } = await signUp();
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email, password, remember: true })
      .expect(200);

    expect(sessionCookie(response)).toMatch(/Max-Age=2592000/);
    expect(fakePrisma.__findUserByEmail(email).failedLoginAttempts).toBe(0);
  });

  it('rejects duplicate signups without creating an orphan school', async () => {
    const { email } = await signUp();
    expect(fakePrisma.__store().schools).toHaveLength(1);

    const response = await request(app)
      .post('/api/auth/signup')
      .send({
        schoolName: 'Another School',
        firstName: 'Eve',
        lastName: 'Dupe',
        email,
        password: DEFAULT_PASSWORD,
      })
      .expect(409);

    expect(response.body.error.code).toBe('CONFLICT');
    expect(fakePrisma.__store().schools).toHaveLength(1);
    expect(fakePrisma.__store().users).toHaveLength(1);
  });

  it('validates signup input with field-level errors', async () => {
    const response = await request(app)
      .post('/api/auth/signup')
      .send({
        schoolName: 'X',
        firstName: '',
        lastName: '',
        email: 'not-an-email',
        password: 'short',
      })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.length).toBeGreaterThan(0);
    expect(fakePrisma.__store().users).toHaveLength(0);
  });

  it('locks the account after repeated failures and unlocks after the window', async () => {
    const { email, password } = await signUp();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'wrong' })
        .expect(401);
    }

    const lockedUser = fakePrisma.__findUserByEmail(email);
    expect(lockedUser.failedLoginAttempts).toBe(3);
    expect(lockedUser.lockedUntil).toBeInstanceOf(Date);

    const locked = await request(app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

    // Simulate the lockout window elapsing (no sleeping in the suite).
    lockedUser.lockedUntil = new Date(Date.now() - 1);

    await request(app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);
    expect(fakePrisma.__findUserByEmail(email).failedLoginAttempts).toBe(0);
    expect(fakePrisma.__findUserByEmail(email).lockedUntil).toBeNull();
  });

  it('does not authenticate inactive accounts', async () => {
    const { email, password } = await signUp();
    fakePrisma.__findUserByEmail(email).isActive = false;

    await request(app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(401);
  });
});

describe('forgot / reset password', () => {
  it('resets the password, consumes the token and revokes every session', async () => {
    const { email, password } = await signUp();
    const agentA = request.agent(app);
    const agentB = request.agent(app);
    await agentA.post('/api/auth/login').send({ email, password }).expect(200);
    await agentB.post('/api/auth/login').send({ email, password }).expect(200);
    const userId = fakePrisma.__findUserByEmail(email).id;
    expect(fakePrisma.__sessionsFor(userId)).toHaveLength(2);

    const unknownEmail = uniqueEmail('nobody');
    const unknown = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: unknownEmail })
      .expect(200);
    const known = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email })
      .expect(200);

    // Same message either way — no account-enumeration oracle.
    expect(known.body.message).toBe(unknown.body.message);
    expect(sentEmails.filter((message) => message.to === unknownEmail)).toHaveLength(0);

    const resetToken = tokenFromLastEmail(email);
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'short' })
      .expect(400);
    expect(fakePrisma.__sessionsFor(userId)).toHaveLength(2);

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: NEW_PASSWORD })
      .expect(200);

    expect(fakePrisma.__sessionsFor(userId)).toHaveLength(0);
    expect(fakePrisma.__tokensFor(userId, 'PASSWORD_RESET')[0].consumedAt).toBeInstanceOf(Date);

    await agentA.get('/api/auth/me').expect(401);
    await agentB.get('/api/auth/me').expect(401);

    await request(app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ email, password: NEW_PASSWORD })
      .expect(200);

    // Reusing the reset token is rejected.
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: NEW_PASSWORD })
      .expect(400);
  });


  it('returns the same public response when password-reset email delivery fails', async () => {
    const { email } = await signUp();
    const unknownEmail = uniqueEmail('mail-failure-unknown');
    const emailSpy = vi.spyOn(emailService, 'sendPasswordResetEmail').mockRejectedValueOnce(new Error('SMTP unavailable'));
    const known = await request(app).post('/api/auth/forgot-password').send({ email }).expect(200);
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: unknownEmail }).expect(200);
    expect(known.body.message).toBe(unknown.body.message);
    expect(fakePrisma.__tokensFor(fakePrisma.__findUserByEmail(email).id, 'PASSWORD_RESET')).toHaveLength(0);
    emailSpy.mockRestore();
  });


  it('rolls back password, token consumption, and session revocation when reset audit persistence fails', async () => {
    const { email, password } = await signUp();
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email, password }).expect(200);
    const userId = fakePrisma.__findUserByEmail(email).id;
    const oldHash = fakePrisma.__findUserByEmail(email).passwordHash;
    const resetRequest = await request(app).post('/api/auth/forgot-password').send({ email }).expect(200);
    expect(resetRequest.body.message).toBeTruthy();
    const resetToken = tokenFromLastEmail(email);
    fakePrisma.__setAuditFailure(true);
    await request(app).post('/api/auth/reset-password').send({ token: resetToken, password: NEW_PASSWORD }).expect(500);
    fakePrisma.__setAuditFailure(false);
    expect(fakePrisma.__findUserByEmail(email).passwordHash).toBe(oldHash);
    expect(fakePrisma.__tokensFor(userId, 'PASSWORD_RESET')[0].consumedAt).toBeNull();
    expect(fakePrisma.__sessionsFor(userId)).toHaveLength(1);
    await request(app).post('/api/auth/reset-password').send({ token: resetToken, password: NEW_PASSWORD }).expect(200);
  });

  it('rejects expired reset tokens', async () => {
    const { email } = await signUp();
    const user = fakePrisma.__findUserByEmail(email);
    const rawToken = 'expired-reset-token';
    await fakePrisma.token.create({
      data: {
        userId: user.id,
        type: 'PASSWORD_RESET',
        tokenHash: hashToken(rawToken, env.SESSION_SECRET),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: rawToken, password: NEW_PASSWORD })
      .expect(400);
  });
});

describe('change password', () => {
  it('requires validation, checks the current password and keeps only this session', async () => {
    const { email, password } = await signUp();
    const agentA = request.agent(app);
    const agentB = request.agent(app);
    await agentA.post('/api/auth/login').send({ email, password }).expect(200);
    await agentB.post('/api/auth/login').send({ email, password }).expect(200);
    const userId = fakePrisma.__findUserByEmail(email).id;

    const missing = await agentA
      .post('/api/auth/change-password')
      .send({ currentPassword: password })
      .expect(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');

    await agentA
      .post('/api/auth/change-password')
      .send({ currentPassword: 'wrong', newPassword: NEW_PASSWORD })
      .expect(400);

    await agentA
      .post('/api/auth/change-password')
      .send({ currentPassword: password, newPassword: NEW_PASSWORD })
      .expect(200);

    expect(fakePrisma.__sessionsFor(userId)).toHaveLength(1);
    await agentA.get('/api/auth/me').expect(200);
    await agentB.get('/api/auth/me').expect(401);

    await request(app)
      .post('/api/auth/login')
      .send({ email, password })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ email, password: NEW_PASSWORD })
      .expect(200);
  });
});

describe('RBAC and user provisioning', () => {
  it.each(['PENDING', 'REJECTED', 'SUSPENDED'])(
    'blocks school user listing for %s schools',
    async (status) => {
      const admin = await signUp();
      const school = fakePrisma.__store().schools[0];
      school.status = status;
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send(admin).expect(200);
      await agent.get('/api/users').expect(403);
    },
  );

  it('scopes school admins to their own school and blocks privilege escalation', async () => {
    const adminA = await signUp({ schoolName: 'School A' });
    const adminB = await signUp({ schoolName: 'School B' });
    const schoolA = fakePrisma.__store().schools[0];
    const schoolB = fakePrisma.__store().schools[1];
    schoolA.status = 'ACTIVE';
    schoolA.planExpiresAt = new Date(Date.now() + 60_000);
    const agentA = request.agent(app);
    await agentA
      .post('/api/auth/login')
      .send({ email: adminA.email, password: adminA.password })
      .expect(200);

    await request(app).get('/api/users').expect(401);

    const listBefore = await agentA.get('/api/users').expect(200);
    expect(listBefore.body.users).toHaveLength(1);
    expect(listBefore.body.users[0].email).toBe(adminA.email);
    expect(listBefore.body.users[0]).not.toHaveProperty('passwordHash');

    const escalate = await agentA
      .post('/api/users')
      .send({
        firstName: 'Super',
        lastName: 'User',
        email: uniqueEmail('super'),
        role: 'SUPER_ADMIN',
      })
      .expect(400);
    expect(escalate.body.error.code).toBe('VALIDATION_ERROR');

    const principalEscalation = await agentA
      .post('/api/users')
      .send({ firstName: 'Second', lastName: 'Principal', email: uniqueEmail('principal'), role: 'SCHOOL_ADMIN' })
      .expect(403);
    expect(principalEscalation.body.error.code).toBe('FORBIDDEN');

    const crossTenant = await agentA
      .post('/api/users')
      .send({
        firstName: 'Other',
        lastName: 'Teacher',
        email: uniqueEmail('teacher'),
        role: 'TEACHER',
        schoolId: schoolB.id,
      })
      .expect(403);

    expect(crossTenant.body.error.code).toBe('FORBIDDEN');

    const teacherEmail = uniqueEmail('teacher');
    const created = await agentA
      .post('/api/users')
      .send({
        firstName: 'Tara',
        lastName: 'Teacher',
        email: teacherEmail,
        role: 'TEACHER',
      })
      .expect(201);

    expect(created.body.user).toMatchObject({
      email: teacherEmail,
      role: 'TEACHER',
      schoolId: schoolA.id,
      mustChangePassword: true,
    });
    expect(created.body.user).not.toHaveProperty('passwordHash');
    expect(created.body.tempPassword).toHaveLength(20);
    expect(created.body.mustChangePassword).toBe(true);

    const storedTeacher = fakePrisma.__findUserByEmail(teacherEmail);
    expect(storedTeacher.passwordHash).not.toBe(created.body.tempPassword);
    await expect(
      verifyPassword(created.body.tempPassword, storedTeacher.passwordHash),
    ).resolves.toBe(true);

    await agentA
      .post('/api/users')
      .send({
        firstName: 'Tara',
        lastName: 'Dupe',
        email: teacherEmail,
        role: 'TEACHER',
      })
      .expect(409);

    const listAfter = await agentA.get('/api/users').expect(200);
    expect(listAfter.body.users).toHaveLength(2);
    expect(listAfter.body.users.map((user: { email: string }) => user.email)).not.toContain(
      adminB.email,
    );

    const teacherAgent = request.agent(app);
    await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: teacherEmail })
      .expect(202);
    await request(app)
      .post('/api/auth/verify-email')
      .send({ token: tokenFromLastEmail(teacherEmail) })
      .expect(200);
    const teacherLogin = await teacherAgent
      .post('/api/auth/login')
      .send({ email: teacherEmail, password: created.body.tempPassword })
      .expect(200);
    expect(teacherLogin.body.user.mustChangePassword).toBe(true);
    await teacherAgent.get('/api/users').expect(403);
  });

  it('does not retain a provisioned user when required audit logging fails (in-memory test double only)', async () => {
    const admin = await signUp();
    const principal = fakePrisma.__findUserByEmail(admin.email);
    fakePrisma.__store().schools.find((item) => item.id === principal.schoolId).status = 'ACTIVE';
    fakePrisma.__store().schools.find((item) => item.id === principal.schoolId).planExpiresAt = new Date(Date.now() + 60_000);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: admin.email, password: admin.password }).expect(200);
    const email = uniqueEmail('audit-failure-user');
    const auditCount = fakePrisma.__store().auditLogs.length;
    fakePrisma.__setAuditFailure(true);
    await agent.post('/api/users').send({ firstName: 'Audit', lastName: 'Failure', email, role: 'TEACHER' }).expect(500);
    expect(fakePrisma.__findUserByEmail(email)).toBeNull();
    expect(fakePrisma.__store().auditLogs).toHaveLength(auditCount);
  });

  it('blocks school staff provisioning while the school is PENDING', async () => {
    const admin = await signUp();
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: admin.email, password: admin.password }).expect(200);
    await agent.post('/api/users').send({
      firstName: 'Pending', lastName: 'Teacher', email: uniqueEmail('pending-teacher'), role: 'TEACHER',
    }).expect(403);
  });

  it('lets a super admin provision users across schools and requires a schoolId', async () => {
    const schoolAdmin = await signUp();
    const superPassword = DEFAULT_PASSWORD;
    const superEmail = uniqueEmail('root');
    const superUser = await fakePrisma.user.create({
      data: {
        email: superEmail,
        passwordHash: await hashPassword(superPassword),
        firstName: 'Super',
        lastName: 'Admin',
        role: 'SUPER_ADMIN',
        schoolId: null,
        isActive: true,
        emailVerifiedAt: new Date(),
      },
    });
    const school = fakePrisma.__findUserByEmail(schoolAdmin.email).schoolId;
    fakePrisma.__store().schools.find((item) => item.id === school).status = 'ACTIVE';
    fakePrisma.__store().schools.find((item) => item.id === school).planExpiresAt = new Date(Date.now() + 60_000);

    const agent = request.agent(app);
    await agent
      .post('/api/auth/login')
      .send({ email: superEmail, password: superPassword })
      .expect(200);

    const list = await agent.get('/api/users').expect(200);
    expect(list.body.users).toHaveLength(2);

    const missingSchool = await agent
      .post('/api/users')
      .send({
        firstName: 'No',
        lastName: 'School',
        email: uniqueEmail('noschool'),
        role: 'PARENT',
      })
      .expect(400);
    expect(missingSchool.body.error.code).toBe('BAD_REQUEST');

    const parentEmail = uniqueEmail('parent');
    const created = await agent
      .post('/api/users')
      .send({
        firstName: 'Pat',
        lastName: 'Parent',
        email: parentEmail,
        role: 'PARENT',
        schoolId: school,
      })
      .expect(201);

    expect(created.body.user.schoolId).toBe(school);
    expect(fakePrisma.__findUserByEmail(parentEmail).role).toBe('PARENT');

    const pendingSchool = await fakePrisma.school.create({ data: { name: 'Initial Principal School', status: 'PENDING' } });
    const principalEmail = uniqueEmail('initial-principal');
    const principalResponse = await agent.post('/api/users').send({
      firstName: 'Initial', lastName: 'Principal', email: principalEmail, role: 'SCHOOL_ADMIN', schoolId: pendingSchool.id,
    }).expect(201);
    expect(principalResponse.body.user.schoolId).toBe(pendingSchool.id);
    const principalAudit = fakePrisma.__store().auditLogs.find((entry) => entry.entityId === principalResponse.body.user.id);
    expect(principalAudit).toMatchObject({ schoolId: pendingSchool.id, action: 'USER_CREATED', entity: 'User' });
    await agent.post('/api/users').send({
      firstName: 'Second', lastName: 'Principal', email: uniqueEmail('second-principal'), role: 'SCHOOL_ADMIN', schoolId: pendingSchool.id,
    }).expect(409);
    expect(superUser.role).toBe('SUPER_ADMIN');
  });

  it.each(['TEACHER', 'PARENT', 'STUDENT'] as const)(
    '%s cannot access school user-management APIs',
    async (role) => {
      const school = await fakePrisma.school.create({ data: { name: 'Role Test School' } });
      const email = uniqueEmail(role.toLowerCase());
      await fakePrisma.user.create({
        data: {
          email,
          passwordHash: await hashPassword(DEFAULT_PASSWORD),
          firstName: role,
          lastName: 'User',
          role,
          schoolId: school.id,
          isActive: true,
          mustChangePassword: false,
          emailVerifiedAt: new Date(),
        },
      });

      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ email, password: DEFAULT_PASSWORD }).expect(200);
      await agent.get('/api/users').expect(403);
      await agent
        .post('/api/users')
        .send({
          firstName: 'Attempt',
          lastName: 'Provisioning',
          email: uniqueEmail('attempt'),
          role: 'STUDENT',
        })
        .expect(403);
    },
  );
});

describe('Principal account and profile provisioning', () => {
  async function activePrincipal() {
    const principal = await signUp({ schoolName: 'Provisioning Test School' });
    const school = fakePrisma.__store().schools[0];
    school.status = 'ACTIVE';
    school.planExpiresAt = new Date(Date.now() + 60_000);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send(principal).expect(200);
    return { agent, school };
  }

  it('creates teacher and parent accounts with profiles, and a student profile linked to an existing parent', async () => {
    const { agent, school } = await activePrincipal();
    const teacherEmail = uniqueEmail('staff-teacher');
    const teacherResponse = await agent.post('/api/academic/teachers/with-account').send({
      firstName: 'Tara', lastName: 'Teacher', email: teacherEmail, subject: 'Science',
    }).expect(201);
    expect(teacherResponse.body).toMatchObject({
      teacher: { firstName: 'Tara', userId: expect.any(String), schoolId: school.id, email: teacherEmail },
      user: { email: teacherEmail, role: 'TEACHER', schoolId: school.id, mustChangePassword: true },
      mustChangePassword: true,
    });
    expect(typeof teacherResponse.body.tempPassword === 'string' && teacherResponse.body.tempPassword.length >= 12).toBe(true);
    expect(fakePrisma.__findUserByEmail(teacherEmail).emailVerifiedAt).toBeNull();

    const parentEmail = uniqueEmail('staff-parent');
    const parentResponse = await agent.post('/api/academic/parents/with-account').send({
      firstName: 'Pia', lastName: 'Parent', email: parentEmail, relationship: 'guardian',
    }).expect(201);
    expect(parentResponse.body).toMatchObject({
      parent: { firstName: 'Pia', userId: expect.any(String), schoolId: school.id },
      user: { email: parentEmail, role: 'PARENT', mustChangePassword: true },
    });

    const studentResponse = await agent.post('/api/academic/students/with-account').send({
      firstName: 'Sam', lastName: 'Student', parentId: parentResponse.body.parent.id,
    }).expect(201);
    expect(studentResponse.body).toMatchObject({
      student: { firstName: 'Sam', parentId: parentResponse.body.parent.id, schoolId: school.id, guardianVerified: false, userId: null },
      user: null,
      mustChangePassword: false,
      verificationEmailStatus: null,
    });
    expect(studentResponse.body).not.toHaveProperty('tempPassword');
    expect(fakePrisma.__store().auditLogs.filter((entry) => entry.schoolId === school.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'TEACHER_ACCOUNT_AND_PROFILE_CREATED', entity: 'Teacher' }),
        expect.objectContaining({ action: 'PARENT_ACCOUNT_AND_PROFILE_CREATED', entity: 'Parent' }),
        expect.objectContaining({ action: 'STUDENT_PROFILE_CREATED', entity: 'Student' }),
      ]),
    );
  });

  it('requires email verification and a first-login password change for newly provisioned accounts', async () => {
    const { agent } = await activePrincipal();
    const email = uniqueEmail('first-login');
    const created = await agent.post('/api/academic/teachers/with-account').send({
      firstName: 'First', lastName: 'Login', email,
    }).expect(201);
    expect(created.body.verificationEmailStatus).toBe('captured');

    const teacherAgent = request.agent(app);
    await teacherAgent.post('/api/auth/login').send({ email, password: created.body.tempPassword }).expect(403);
    await request(app).post('/api/auth/verify-email').send({ token: tokenFromLastEmail(email) }).expect(200);
    const login = await teacherAgent.post('/api/auth/login').send({ email, password: created.body.tempPassword }).expect(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    await teacherAgent.get('/api/academic/teachers').expect(403);
  });

  it('rejects duplicate emails with a clear conflict and does not create a second profile', async () => {
    const { agent } = await activePrincipal();
    const email = uniqueEmail('duplicate-member');
    await agent.post('/api/academic/teachers/with-account').send({
      firstName: 'Same', lastName: 'Email', email,
    }).expect(201);
    const duplicate = await agent.post('/api/academic/parents/with-account').send({
      firstName: 'Other', lastName: 'Profile', email,
    }).expect(409);
    expect(duplicate.body.error.message).toMatch(/email already exists/i);
    expect(fakePrisma.__store().parents).toHaveLength(0);
  });

  it('rejects linking a student to a parent from another school', async () => {
    const { agent } = await activePrincipal();
    const otherSchool = await fakePrisma.school.create({
      data: { name: 'Other School', status: 'ACTIVE', planExpiresAt: new Date(Date.now() + 60_000) },
    });
    const otherParent = await fakePrisma.parent.create({
      data: { firstName: 'Other', lastName: 'Guardian', schoolId: otherSchool.id },
    });
    const result = await agent.post('/api/academic/students/with-account').send({
      firstName: 'Cross', lastName: 'Tenant', parentId: otherParent.id,
    }).expect(400);
    expect(result.body.error.message).toMatch(/parent is invalid for this school/i);
    expect(fakePrisma.__store().students).toHaveLength(0);
  });

  it('rolls back both account and profile when strict audit logging fails', async () => {
    const { agent } = await activePrincipal();
    const email = uniqueEmail('rollback-member');
    const auditCount = fakePrisma.__store().auditLogs.length;
    const tokenCount = fakePrisma.__store().tokens.length;
    fakePrisma.__setAuditFailure(true);
    await agent.post('/api/academic/teachers/with-account').send({
      firstName: 'Audit', lastName: 'Failure', email,
    }).expect(500);
    expect(fakePrisma.__findUserByEmail(email)).toBeNull();
    expect(fakePrisma.__store().teachers).toHaveLength(0);
    expect(fakePrisma.__store().tokens).toHaveLength(tokenCount);
    expect(fakePrisma.__store().auditLogs).toHaveLength(auditCount);
  });

  it.each(['TEACHER', 'PARENT', 'STUDENT', 'SUPER_ADMIN'] as const)(
    'does not allow %s to provision school member accounts',
    async (role) => {
      const school = await fakePrisma.school.create({
        data: { name: 'Role Test School', status: 'ACTIVE', planExpiresAt: new Date(Date.now() + 60_000) },
      });
      const email = uniqueEmail(`provision-${role.toLowerCase()}`);
      await fakePrisma.user.create({
        data: {
          email,
          passwordHash: await hashPassword(DEFAULT_PASSWORD),
          firstName: role,
          lastName: 'Account',
          role,
          schoolId: role === 'SUPER_ADMIN' ? null : school.id,
          isActive: true,
          emailVerifiedAt: new Date(),
        },
      });
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ email, password: DEFAULT_PASSWORD }).expect(200);
      await agent.post('/api/academic/teachers/with-account').send({
        firstName: 'Attempt', lastName: 'Create', email: uniqueEmail('attempt'),
      }).expect(403);
    },
  );

  it('requires an authenticated Principal session', async () => {
    await request(app).post('/api/academic/teachers/with-account').send({
      firstName: 'Unauthenticated', lastName: 'Attempt', email: uniqueEmail('unauthenticated'),
    }).expect(401);
  });
});
