/**
 * Express Request augmentation.
 *
 * Adds the `user` and `session` properties populated by the auth middleware so
 * the rest of the codebase is statically typed instead of reaching for `any`.
 * `Role` is mirrored from the Prisma enum as a string union so this declaration
 * file does not need the generated client to exist.
 */

export type Role =
  | 'SUPER_ADMIN'
  | 'SCHOOL_ADMIN'
  | 'TEACHER'
  | 'STUDENT'
  | 'PARENT';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  schoolId: string | null;
  mustChangePassword: boolean;
  emailVerifiedAt: Date | null;
  publicCode: string | null;
  username: string | null;
}

export interface AuthSession {
  id: string;
  /** Stored hash of the cookie token (never the plaintext). */
  token: string;
  userId: string;
  expiresAt: Date;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    session?: AuthSession;
  }
}

export {};
