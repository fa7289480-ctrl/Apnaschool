/**
 * Token service — random opaque tokens + SHA-256 hashing.
 *
 * Used for both session tokens (cookie → DB lookup) and email verification /
 * password reset tokens. Only the hash is stored; the plaintext never is.
 * A pepper (SESSION_SECRET) is folded into the hash so that a database leak
 * alone cannot produce a usable token.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** URL-safe base64 of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256(`token` : `pepper`). Same token + pepper always yields the same hash. */
export function hashToken(token: string, pepper = ''): string {
  return createHash('sha256')
    .update(`${token}:${pepper}`)
    .digest('hex');
}

/** Generate a token and its hash together. */
export function generateToken(pepper = ''): { token: string; tokenHash: string } {
  const token = randomToken();
  return { token, tokenHash: hashToken(token, pepper) };
}

/** Constant-time comparison of two hex hash strings. */
export function safeEqualHash(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
