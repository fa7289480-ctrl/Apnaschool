/**
 * Authentication & RBAC middleware.
 *
 * Exposed as a factory (`createAuthMiddleware`) so the session resolver can be
 * swapped for a stub in unit tests — that lets us test role checks and
 * "unauthenticated" rejections without a database. `app.ts` wires the real
 * `getSessionFromCookie`; tests pass a fake.
 */

import type { Request, Response, NextFunction } from 'express';
import type { Role, AuthUser, AuthSession } from '../types/express.js';
import { unauthorized, forbidden } from './errorHandler.js';
import type { SessionUserResult } from '../services/sessions.js';

export interface AuthDeps {
  getSession: (req: Request) => Promise<SessionUserResult | null>;
}

export function createAuthMiddleware(deps: AuthDeps) {
  /** Require a valid session; attach `req.user` / `req.session`. */
  const requireAuth = async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await deps.getSession(req);
      if (!result) {
        next(unauthorized('Authentication required'));
        return;
      }
      req.user = result.user;
      req.session = result.session;
      next();
    } catch (err) {
      next(err);
    }
  };

  /** Prevent provisioned users from accessing protected features until they
   * change their temporary password. Keep only the minimum recovery endpoints
   * available; routes that use this middleware must opt in after requireAuth. */
  const requirePasswordChangeComplete = (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void => {
    if (!req.user) {
      next(unauthorized('Authentication required'));
      return;
    }
    if (req.user.mustChangePassword) {
      next(forbidden('You must change your temporary password before continuing (PASSWORD_CHANGE_REQUIRED)'));
      return;
    }
    next();
  };

  /**
   * Require one of the given roles. SUPER_ADMIN is *not* implicit — pass it
   * explicitly for super-admin-only endpoints (e.g. user provisioning).
   */
  const requireRole =
    (...allowed: Role[]) =>
    (req: Request, _res: Response, next: NextFunction): void => {
      if (!req.user) {
        next(unauthorized('Authentication required'));
        return;
      }
      if (allowed.includes(req.user.role)) {
        next();
        return;
      }
      next(forbidden('You do not have permission to do that'));
    };

  /** Convenience: SUPER_ADMIN only. */
  const requireSuperAdmin = requireRole('SUPER_ADMIN');

  return { requireAuth, requireRole, requireSuperAdmin, requirePasswordChangeComplete };
}

/** Safe user payload to return to clients (never the password hash). */
export function publicUser(u: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  schoolId: string | null;
  mustChangePassword: boolean;
  emailVerifiedAt: Date | null;
  publicCode?: string | null;
  username?: string | null;
}) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role,
    schoolId: u.schoolId,
    mustChangePassword: u.mustChangePassword,
    emailVerified: u.emailVerifiedAt !== null,
    publicCode: u.publicCode ?? null,
    username: u.username ?? null,
  };
}

export type { AuthUser, AuthSession };
