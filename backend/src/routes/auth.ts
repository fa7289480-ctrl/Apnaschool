/**
 * Authentication routes.
 *
 * All mounted under /api/auth. Session cookies (httpOnly, SameSite) are issued
 * by the session service. State-changing requests are CSRF-guarded in app.ts.
 *
 * Email/username enumeration is avoided: login, forgot-password and
 * verify/reset all return generic messages that don't disclose whether an
 * account exists.
 */

import { Router } from 'express';
import { Role, SchoolStatus, TokenType } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { authRateLimiter } from '../middleware/rateLimit.js';
import { logger } from '../middleware/requestLogger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  badRequest,
  conflict,
  unauthorized,
} from '../middleware/errorHandler.js';
import { createAuthMiddleware, publicUser } from '../middleware/auth.js';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
} from '../services/password.js';
import { generateToken, hashToken } from '../services/token.js';
import {
  createSession,
  revokeSession,
  getSessionFromCookie,
} from '../services/sessions.js';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from '../services/email.js';
import { recordAudit, recordAuditStrict } from '../services/audit.js';
import { parseApprovalMode, trialEndFrom } from '../services/schoolLifecycle.js';
import { nextSchoolPublicCode, nextUserPublicCode, suggestUsername } from '../services/publicCodes.js';

export const authRouter = Router();

const PEPPER = env.SESSION_SECRET;

// Real session resolver — populates req.user / req.session for authenticated routes.
const { requireAuth } = createAuthMiddleware({ getSession: getSessionFromCookie });

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address');

const passwordField = z
  .string()
  .min(env.PASSWORD_MIN_LENGTH, `Use at least ${env.PASSWORD_MIN_LENGTH} characters`)
  .max(env.PASSWORD_MAX_LENGTH);

function tokenExpiry(): Date {
  return new Date(Date.now() + env.TOKEN_TTL_MINUTES * 60 * 1000);
}

// ── Login ────────────────────────────────────────────────────────────────
// Backward compatible: clients still send `email`, which may be a real email,
// publicCode (PRI-0001), or username. Optional `identifier` is an alias.
const loginSchema = z.object({
  email: z.string().trim().min(1).max(254).optional(),
  identifier: z.string().trim().min(1).max(254).optional(),
  password: z.string().min(1, 'Enter your password'),
  remember: z.boolean().optional().default(false),
}).strict().superRefine((body, ctx) => {
  if (!body.email && !body.identifier) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'Enter email, public ID or username' });
  }
});

authRouter.post(
  '/login',
  authRateLimiter,
  validate.body(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, identifier, password, remember } = req.body as z.infer<
      typeof loginSchema
    >;

    const lookup = (email ?? identifier ?? '').trim();
    let user = null as Awaited<ReturnType<typeof prisma.user.findFirst>>;
    if (lookup.includes('@')) {
      user = await prisma.user.findUnique({ where: { email: lookup.toLowerCase() } });
    } else {
      user =
        (await prisma.user.findFirst({ where: { publicCode: { equals: lookup, mode: 'insensitive' } } })) ||
        (await prisma.user.findFirst({ where: { username: { equals: lookup, mode: 'insensitive' } } }));
    }
    const invalid = () =>
      res
        .status(401)
        .json({ error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } });

    if (!user) return invalid();

    // Lockout
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return res.status(423).json({
        error: {
          message: 'Too many failed attempts. Try again later.',
          code: 'ACCOUNT_LOCKED',
        },
      });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok || !user.isActive) {
      const attempts = user.failedLoginAttempts + 1;
      const shouldLock = attempts >= env.LOGIN_MAX_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: shouldLock
            ? new Date(Date.now() + env.LOGIN_LOCKOUT_MS)
            : null,
        },
      });
      await recordAudit(req, {
        userId: user.id,
        action: 'LOGIN_FAILED',
        entity: 'User',
        entityId: user.id,
      });
      return invalid();
    }

    // A verified address is required before a session can be issued. Do not
    // create a session for unverified accounts; return a stable actionable code.
    if (!user.emailVerifiedAt) {
      await recordAudit(req, {
        userId: user.id,
        schoolId: user.schoolId,
        action: 'LOGIN_BLOCKED_UNVERIFIED_EMAIL',
        entity: 'User',
        entityId: user.id,
      });
      return res.status(403).json({
        error: {
          message: 'Verify your email address before signing in. Check your inbox for the verification link.',
          code: 'EMAIL_NOT_VERIFIED',
        },
      });
    }

    // Success — clear attempts, stamp login, transparent rehash if needed.
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    if (needsRehash(user.passwordHash)) {
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    const { token, session } = await createSession(req, res, { id: user.id }, { remember });
    await recordAudit(req, {
      userId: user.id,
      schoolId: user.schoolId,
      action: 'LOGIN_SUCCESS',
      entity: 'User',
      entityId: user.id,
    });

    return res.json({
      user: publicUser(user),
      session: { id: session.id, expiresAt: session.expiresAt },
      ...(req.get('x-apnaschool-client') === 'native' ? { token } : {}),
    });
  }),
);

// ── Logout ───────────────────────────────────────────────────────────────
authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await recordAudit(req, {
      userId: req.user!.id,
      schoolId: req.user!.schoolId,
      action: 'LOGOUT',
      entity: 'User',
      entityId: req.user!.id,
    });
    await revokeSession(req, res);
    res.json({ message: 'Signed out' });
  }),
);

// ── Current user ─────────────────────────────────────────────────────────
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user!) });
});

// ── Signup (Principal + School, PENDING) ──────────────────────────────────
const signupSchema = z.object({
  schoolName: z.string().trim().min(2).max(200),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: emailField,
  password: passwordField,
});

authRouter.post(
  '/signup',
  authRateLimiter,
  validate.body(signupSchema),
  asyncHandler(async (req, res, next) => {
    const { schoolName, firstName, lastName, email, password } = req.body as z.infer<
      typeof signupSchema
    >;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return next(conflict('An account with this email already exists'));

    const passwordHash = await hashPassword(password);
    const { user, schoolPublicCode, principalPublicCode } = await prisma.$transaction(async (tx) => {
      const approvalSetting = await tx.platformSetting.findUnique({
        where: { key: 'schoolApprovalMode' },
        select: { value: true },
      });
      // The absence of a platform setting intentionally defaults to approval-first.
      const approvalMode = parseApprovalMode(approvalSetting?.value);
      const now = new Date();
      const autoApproved = approvalMode === 'AUTOMATIC';
      const schoolPublicCode = await nextSchoolPublicCode(tx);
      const principalPublicCode = await nextUserPublicCode(Role.SCHOOL_ADMIN, tx);
      const username = suggestUsername(firstName, principalPublicCode);
      const school = await tx.school.create({
        data: {
          name: schoolName,
          publicCode: schoolPublicCode,
          status: autoApproved ? SchoolStatus.TRIAL : SchoolStatus.PENDING,
          ...(autoApproved ? { trialStartsAt: now, trialEndsAt: trialEndFrom(now), approvedAt: now } : {}),
        },
      });
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          firstName,
          lastName,
          role: Role.SCHOOL_ADMIN,
          schoolId: school.id,
          publicCode: principalPublicCode,
          username,
        },
      });
      await recordAuditStrict(req, {
        userId: user.id,
        schoolId: school.id,
        action: 'SIGNUP',
        entity: 'User',
        entityId: user.id,
        metadata: {
          approvalMode,
          schoolStatus: autoApproved ? SchoolStatus.TRIAL : SchoolStatus.PENDING,
          schoolPublicCode,
          principalPublicCode,
        },
      }, tx);
      return { user, schoolPublicCode, principalPublicCode };
    });

    const { token, tokenHash } = generateToken(PEPPER);
    await prisma.token.create({
      data: {
        userId: user.id,
        type: TokenType.EMAIL_VERIFICATION,
        tokenHash,
        expiresAt: tokenExpiry(),
      },
    });

    const verificationUrl = `${env.APP_BASE_URL}/verify-email.html?token=${encodeURIComponent(token)}`;
    await sendVerificationEmail(email, { name: firstName, verificationUrl });

    res.status(201).json({
      message: 'Account created. Check your email to verify your account.',
      schoolPublicCode,
      principalPublicCode,
    });
  }),
);

// ── Verify email ─────────────────────────────────────────────────────────
const verifyEmailSchema = z.object({ token: z.string().min(1) });

authRouter.post(
  '/verify-email',
  validate.body(verifyEmailSchema),
  asyncHandler(async (req, res, next) => {
    const { token } = req.body as z.infer<typeof verifyEmailSchema>;
    const record = await prisma.token.findUnique({
      where: { tokenHash: hashToken(token, PEPPER) },
    });
    if (!record || record.type !== TokenType.EMAIL_VERIFICATION) {
      return next(badRequest('Invalid or expired verification link'));
    }
    if (record.consumedAt) return next(badRequest('This verification link has already been used'));
    if (record.expiresAt.getTime() <= Date.now()) {
      return next(badRequest('This verification link has expired'));
    }

    const consumedAt = new Date();
    await prisma.$transaction(async (tx) => {
      // Conditional consume is the single-use guarantee under concurrent requests.
      const consumed = await tx.token.updateMany({
        where: { id: record.id, type: TokenType.EMAIL_VERIFICATION, consumedAt: null, expiresAt: { gt: consumedAt } },
        data: { consumedAt },
      });
      if (consumed.count !== 1) throw badRequest('Invalid or expired verification link');
      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: consumedAt },
      });
      await recordAuditStrict(req, {
        userId: record.userId,
        action: 'EMAIL_VERIFIED',
        entity: 'User',
        entityId: record.userId,
      }, tx);
    });
    res.json({ message: 'Email verified. You can now sign in.' });
  }),
);

// ── Resend verification ──────────────────────────────────────────────────
// This endpoint must be usable before login: unverified accounts cannot obtain
// a session. Keep responses identical for unknown and already-verified emails.
const resendVerificationSchema = z.object({ email: emailField });
authRouter.post(
  '/resend-verification',
  authRateLimiter,
  validate.body(resendVerificationSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as z.infer<typeof resendVerificationSchema>;
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && user.isActive) {
      const { token, tokenHash } = generateToken(PEPPER);
      // Persist the new token without invalidating existing links. If email
      // delivery fails, remove only this new token and preserve any previously
      // delivered, unexpired token so the user is not locked out of recovery.
      const createdToken = await prisma.token.create({
        data: {
          userId: user.id,
          type: TokenType.EMAIL_VERIFICATION,
          tokenHash,
          expiresAt: tokenExpiry(),
        },
      });
      const verificationUrl = `${env.APP_BASE_URL}/verify-email.html?token=${encodeURIComponent(token)}`;
      try {
        await sendVerificationEmail(user.email, {
          name: user.firstName,
          verificationUrl,
        });
      } catch (error) {
        try {
          await prisma.token.deleteMany({ where: { id: createdToken.id } });
        } catch (cleanupError) {
          // Log only a stable action and error class; never the token or URL.
          logger.error({ action: 'verification_token_cleanup_failed', errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError' }, 'verification token cleanup failed');
        }
        // Keep the response generic to avoid account enumeration. Existing
        // tokens remain usable and the user can retry this public endpoint.
        logger.error({ action: 'verification_email_delivery_failed', errorName: error instanceof Error ? error.name : 'UnknownError' }, 'verification email delivery failed');
      }
    }
    res.status(202).json({
      message: 'If an unverified account exists for this address, verification instructions will be sent. If they do not arrive, try again later.',
    });
  }),
);

// ── Forgot password ──────────────────────────────────────────────────────
const forgotPasswordSchema = z.object({ email: emailField });

authRouter.post(
  '/forgot-password',
  authRateLimiter,
  validate.body(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as z.infer<typeof forgotPasswordSchema>;
    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      let createdTokenId: string | undefined;
      try {
        const { token, tokenHash } = generateToken(PEPPER);
        const createdToken = await prisma.token.create({
          data: {
            userId: user.id,
            type: TokenType.PASSWORD_RESET,
            tokenHash,
            expiresAt: tokenExpiry(),
          },
        });
        createdTokenId = createdToken.id;
        const resetUrl = `${env.APP_BASE_URL}/reset-password.html?token=${encodeURIComponent(token)}`;
        await sendPasswordResetEmail(user.email, { name: user.firstName, resetUrl });
        await recordAudit(req, {
          userId: user.id,
          action: 'PASSWORD_RESET_REQUESTED',
          entity: 'User',
          entityId: user.id,
        });
      } catch (error) {
        // Keep the public response uniform for persistence and mail failures.
        // Remove only this undelivered token; preserve any previously delivered link.
        if (createdTokenId) await prisma.token.deleteMany({ where: { id: createdTokenId } }).catch(() => {});
        logger.error({ action: 'password_reset_delivery_or_persistence_failed', errorName: error instanceof Error ? error.name : 'UnknownError' }, 'password reset request could not be completed');
      }
    }

    // Always the same response — never disclose whether the email is registered.
    res.json({
      message: 'If an account exists for that email, a reset link has been sent.',
    });
  }),
);

// ── Reset password ───────────────────────────────────────────────────────
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordField,
});

authRouter.post(
  '/reset-password',
  validate.body(resetPasswordSchema),
  asyncHandler(async (req, res, next) => {
    const { token, password } = req.body as z.infer<typeof resetPasswordSchema>;
    const record = await prisma.token.findUnique({
      where: { tokenHash: hashToken(token, PEPPER) },
    });
    if (!record || record.type !== TokenType.PASSWORD_RESET || record.consumedAt) {
      return next(badRequest('Invalid or expired reset link'));
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      return next(badRequest('This reset link has expired'));
    }

    const passwordHash = await hashPassword(password);
    const consumedAt = new Date();
    await prisma.$transaction(async (tx) => {
      // Atomically claim the token. Concurrent reset requests cannot both succeed.
      const consumed = await tx.token.updateMany({
        where: { id: record.id, type: TokenType.PASSWORD_RESET, consumedAt: null, expiresAt: { gt: consumedAt } },
        data: { consumedAt },
      });
      if (consumed.count !== 1) throw badRequest('Invalid or expired reset link');
      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      await tx.session.deleteMany({ where: { userId: record.userId } });
      await recordAuditStrict(req, {
        userId: record.userId,
        action: 'PASSWORD_RESET',
        entity: 'User',
        entityId: record.userId,
      }, tx);
    });
    res.json({ message: 'Password reset. You can now sign in.' });
  }),
);

// ── Change password ──────────────────────────────────────────────────────
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
});

authRouter.post(
  '/change-password',
  requireAuth,
  validate.body(changePasswordSchema),
  asyncHandler(async (req, res, next) => {
    const { currentPassword, newPassword } = req.body as z.infer<
      typeof changePasswordSchema
    >;

    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return next(unauthorized('Authentication required'));

    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) return next(badRequest('Current password is incorrect'));

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false },
      });
      // Keep the current session, revoke every other session, and record the
      // security event atomically so a successful response cannot hide audit failure.
      await tx.session.deleteMany({
        where: { userId: user.id, NOT: { id: req.session!.id } },
      });
      await recordAuditStrict(req, {
        userId: user.id,
        schoolId: user.schoolId,
        action: 'PASSWORD_CHANGED',
        entity: 'User',
        entityId: user.id,
      }, tx);
    });
    res.json({ message: 'Password changed.' });
  }),
);
