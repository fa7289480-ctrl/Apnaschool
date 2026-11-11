/**
 * User management — admin provisioning endpoint.
 *
 * Demonstrates the "temp password + mandatory change" flow and server-side
 * RBAC. There is NO public admin-creation route: only an authenticated Super
 * Admin or School Admin (Principal) may provision users, and the SUPER_ADMIN
 * role can never be created through the API (only via the secure bootstrap
 * seed). School Admins are confined to their own school.
 */

import { Router, type RequestHandler } from 'express';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  badRequest,
  conflict,
  forbidden,
} from '../middleware/errorHandler.js';
import { createAuthMiddleware, publicUser } from '../middleware/auth.js';
import { getSessionFromCookie } from '../services/sessions.js';
import { hashPassword, generateTempPassword } from '../services/password.js';
import { recordAuditStrict } from '../services/audit.js';
import { assertUserProvisioningAllowed } from '../services/userProvisioningPolicy.js';
import { schoolIsolation } from '../middleware/schoolIsolation.js';

export const usersRouter = Router();

const { requireAuth, requireRole, requirePasswordChangeComplete } = createAuthMiddleware({
  getSession: getSessionFromCookie,
});
const requireUserListSchoolAccess: RequestHandler = (req, res, next) => {
  if (req.user?.role === 'SUPER_ADMIN') {
    next();
    return;
  }
  return schoolIsolation()(req, res, next);
};

// Roles that may be provisioned through the API. SUPER_ADMIN is deliberately
// absent — super admins are only created by the secure bootstrap seed.
const provisionableRoles = [
  'SCHOOL_ADMIN',
  'TEACHER',
  'STUDENT',
  'PARENT',
] as const;

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address');

const createSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: emailField,
  role: z.enum(provisionableRoles),
  schoolId: z.string().min(1).optional(),
});

// ── Provision a user (temp password, forced change) ──────────────────────
usersRouter.post(
  '/',
  requireAuth,
  requirePasswordChangeComplete,
  requireRole('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  validate.body(createSchema),
  asyncHandler(async (req, res, next) => {
    const { firstName, lastName, email, role } = req.body as z.infer<
      typeof createSchema
    >;
    const requestedSchoolId: string | undefined = req.body.schoolId;

    // Resolve the target school from the caller's authority.
    let schoolId: string;
    if (req.user!.role === 'SCHOOL_ADMIN') {
      const callerSchoolId = req.user!.schoolId;
      if (!callerSchoolId) {
        return next(forbidden('Your account is not linked to a school'));
      }
      if (requestedSchoolId && requestedSchoolId !== callerSchoolId) {
        return next(forbidden('You can only create users in your own school'));
      }
      schoolId = callerSchoolId;
    } else {
      // SUPER_ADMIN must name the school explicitly.
      if (!requestedSchoolId) {
        return next(badRequest('schoolId is required'));
      }
      schoolId = requestedSchoolId;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    // Serialize provisioning with school lifecycle transitions and other
    // provisioning attempts. The lifecycle and initial-Principal checks are
    // repeated inside the same transaction as user creation and audit.
    let user: Awaited<ReturnType<typeof prisma.user.create>>;
    try {
      user = await prisma.$transaction(async (tx) => {
        const lockedSchools = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "School" WHERE "id" = ${schoolId} FOR UPDATE
        `;
        if (lockedSchools.length === 0) throw badRequest('School not found');

        const school = await tx.school.findUnique({
          where: { id: schoolId },
          select: { id: true, status: true, trialEndsAt: true, planExpiresAt: true },
        });
        if (!school) throw badRequest('School not found');

        let existingPrincipal = false;
        if (role === 'SCHOOL_ADMIN') {
          existingPrincipal = Boolean(await tx.user.findFirst({
            where: { schoolId, role: Role.SCHOOL_ADMIN },
            select: { id: true },
          }));
        }
        assertUserProvisioningAllowed({
          callerRole: req.user!.role,
          targetRole: role as Role,
          schoolStatus: school.status,
          trialEndsAt: school.trialEndsAt,
          planExpiresAt: school.planExpiresAt,
          existingPrincipal,
        });

        const { nextUserPublicCode, suggestUsername } = await import('../services/publicCodes.js');
        const publicCode = await nextUserPublicCode(role as Role, tx);
        const username = suggestUsername(firstName, publicCode);

        // The unique email constraint remains the final race-safe duplicate
        // guard; any conflict aborts this transaction and its audit write.
        const createdUser = await tx.user.create({
          data: {
            email,
            passwordHash,
            firstName,
            lastName,
            role: role as Role,
            schoolId,
            publicCode,
            username,
            mustChangePassword: true,
            isActive: true,
          },
        });

        await recordAuditStrict(req, {
          userId: req.user!.id,
          schoolId,
          action: 'USER_CREATED',
          entity: 'User',
          entityId: createdUser.id,
          metadata: { createdUserId: createdUser.id, role, publicCode, username },
        }, tx);

        return createdUser;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      // Translate database duplicate-email conflicts without exposing SQL or
      // internal error details. Other errors continue through the safe handler.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        return next(conflict('An account with this email already exists'));
      }
      throw error;
    }

    // The temp password is returned exactly once so the admin can relay it
    // out-of-band. The recipient must change it on first login.
    res.status(201).json({
      user: publicUser(user),
      tempPassword,
      mustChangePassword: true,
    });
  }),
);

// ── List users (scoped) ──────────────────────────────────────────────────
usersRouter.get(
  '/',
  requireAuth,
  requirePasswordChangeComplete,
  requireRole('SUPER_ADMIN', 'SCHOOL_ADMIN'),
  requireUserListSchoolAccess,
  asyncHandler(async (req, res) => {
    const where =
      req.user!.role === 'SUPER_ADMIN'
        ? {}
        : { schoolId: req.user!.schoolId };
    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        schoolId: true,
        isActive: true,
        mustChangePassword: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });
    res.json({ users: users.map((u) => ({ ...publicUser(u), createdAt: u.createdAt })) });
  }),
);

// Re-export for tests.
export { provisionableRoles };
