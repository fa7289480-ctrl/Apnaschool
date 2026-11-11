/**
 * Session service — database-backed sessions over httpOnly cookies.
 *
 * Flow:
 *   createSession() → random opaque token → store only its hash in the DB →
 *   hand the *plaintext* token to the browser in an httpOnly, SameSite cookie.
 *
 * The plaintext token is never stored, so a DB leak alone cannot hijack a
 * session. Revocation = deleting the row (logout) or revoking by id/user.
 */

import type { Request, Response } from 'express';

import { prisma } from '../lib/prisma.js';
import { env, cookieSecure } from '../config/env.js';
import { generateToken, hashToken } from './token.js';
import type { AuthUser, AuthSession } from '../types/express.js';

const PEPPER = env.SESSION_SECRET;

function cookieMaxAge(remember: boolean): number {
  return (
    (remember ? env.SESSION_REMEMBER_TTL_SECONDS : env.SESSION_TTL_SECONDS) *
    1000
  );
}

function sameSiteValue(): boolean | 'none' | 'lax' | 'strict' {
  return env.COOKIE_SAMESITE;
}

export interface SessionUserResult {
  session: AuthSession;
  user: AuthUser;
}

/** Create a session for `user`, persist the token hash, and set the cookie. */
export async function createSession(
  req: Request,
  res: Response,
  user: { id: string },
  opts: { remember?: boolean } = {},
): Promise<{ token: string; session: AuthSession }> {
  const remember = opts.remember ?? false;
  const { token, tokenHash } = generateToken(PEPPER);
  const maxAgeMs = cookieMaxAge(remember);
  const expiresAt = new Date(Date.now() + maxAgeMs);

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      token: tokenHash,
      expiresAt,
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    },
  });

  setSessionCookie(res, token, remember);
  return {
    token,
    session: {
      id: session.id,
      token: tokenHash,
      userId: session.userId,
      expiresAt: session.expiresAt,
    },
  };
}

/** Look up the session + user from the cookie token or Authorization header. Returns null if invalid. */
export async function getSessionFromCookie(
  req: Request,
): Promise<SessionUserResult | null> {
  let token = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!token || typeof token !== 'string') {
    const authHeader = req.get('authorization');
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      token = authHeader.replace(/^Bearer\s+/i, '').trim();
    }
  }
  if (!token || typeof token !== 'string') return null;

  const tokenHash = hashToken(token, PEPPER);
  const session = await prisma.session.findUnique({
    where: { token: tokenHash },
    include: { user: true },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    // Expired — clean up and refuse.
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (!session.user.isActive) return null;

  return {
    session: {
      id: session.id,
      token: tokenHash,
      userId: session.userId,
      expiresAt: session.expiresAt,
    },
    user: toAuthUser(session.user),
  };
}

/** Delete the session referenced by the request cookie or Authorization header and clear the cookie. */
export async function revokeSession(
  req: Request,
  res: Response,
): Promise<void> {
  let token = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!token || typeof token !== 'string') {
    const authHeader = req.get('authorization');
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      token = authHeader.replace(/^Bearer\s+/i, '').trim();
    }
  }
  if (token && typeof token === 'string') {
    await prisma.session
      .delete({ where: { token: hashToken(token, PEPPER) } })
      .catch(() => {});
  }
  clearSessionCookie(res);
}

/** Delete every session for a user (used on password change/reset). */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } }).catch(() => {});
}

/** Delete a single session by id (admin revocation). */
export async function revokeSessionById(id: string): Promise<void> {
  await prisma.session.delete({ where: { id } }).catch(() => {});
}

export function setSessionCookie(
  res: Response,
  token: string,
  remember: boolean,
): void {
  res.cookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecure || sameSiteValue() === 'none',
    sameSite: sameSiteValue(),
    path: '/',
    maxAge: cookieMaxAge(remember),
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(env.SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure || sameSiteValue() === 'none',
    sameSite: sameSiteValue(),
    path: '/',
  });
}

function toAuthUser(u: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: unknown;
  schoolId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  emailVerifiedAt: Date | null;
  publicCode?: string | null;
  username?: string | null;
}): AuthUser {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role as AuthUser['role'],
    schoolId: u.schoolId,
    mustChangePassword: u.mustChangePassword,
    emailVerifiedAt: u.emailVerifiedAt,
    publicCode: u.publicCode ?? null,
    username: u.username ?? null,
  };
}
