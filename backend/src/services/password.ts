/**
 * Password service — Argon2id hashing & verification.
 *
 * Argon2id is the recommended password hash (OWASP / RFC 9106). We use the
 * library defaults tuned to the OWASP cheat-sheet baseline (64 MiB memory,
 * 2 iterations, parallelism 1). `needsRehash` lets login transparently upgrade
 * hashes if these parameters are ever raised.
 */

import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

/** Tuning — OWASP-recommended Argon2id baseline. */
export const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 64 MiB
  timeCost: 2,
  parallelism: 1,
};

/** Hash a plaintext password with Argon2id. */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

/** Verify a plaintext password against a stored Argon2id hash. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

/**
 * True if the stored hash was produced with weaker parameters than the current
 * ones — the caller should re-hash and store on the next successful login.
 */
export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, HASH_OPTIONS);
}

/**
 * Generate a random temporary password (used when an admin provisions a user).
 * Mixed-case letters + digits, no ambiguous-looking symbols, so it can be read
 * aloud / typed. The recipient must change it on first login.
 */
export function generateTempPassword(length = 20): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
