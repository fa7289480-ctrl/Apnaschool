/**
 * CSRF protection for cookie-based auth.
 *
 * Strategy: SameSite cookies (set by the session service) block the bulk of
 * CSRF, and this guard closes the gap for state-changing requests by requiring
 * an `Origin` (or `Referer`) that matches an allowed origin. Browsers send
 * `Origin` on same-origin POST/PUT/PATCH/DELETE, so legitimate SPA requests
 * pass; a forged cross-site form POST has a different (or missing) Origin.
 *
 * Safe methods (GET/HEAD/OPTIONS) are never checked. Skipped entirely under
 * test so integration tests don't have to set the header.
 */

import type { Request, Response, NextFunction } from 'express';
import { isCorsOriginAllowed, isTest } from '../config/env.js';
import { forbidden } from './errorHandler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Pure: is this Origin allowed? Unit-tested directly. */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowed: readonly string[],
): boolean {
  if (!origin) return false;
  return allowed.includes(origin);
}

/** Extract the request's origin from the `Origin` header, falling back to Referer. */
export function requestOrigin(req: Request): string | null {
  const origin = req.get('origin');
  if (origin) return origin;
  const referer = req.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

export function csrfGuard(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (isTest) {
    next();
    return;
  }
  // Token-authenticated requests (Bearer token) are not vulnerable to ambient browser cookie CSRF.
  const authHeader = req.get('authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    next();
    return;
  }
  const origin = requestOrigin(req);
  if (!origin || !isCorsOriginAllowed(origin)) {
    next(forbidden('Origin not allowed (CSRF check failed)'));
    return;
  }
  next();
}
