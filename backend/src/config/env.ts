/**
 * Environment variable validation.
 *
 * Loads .env, validates every required variable with Zod, and exports a
 * typed `env` object. The app refuses to start if any required variable is
 * missing or invalid — fail fast, fail loud, never run with a silent misconfig.
 *
 * Secrets (DATABASE_URL, SESSION_SECRET, SMTP_PASSWORD, SEED_SUPER_ADMIN_PASSWORD)
 * live only in the environment / .env (which is gitignored). They are never
 * logged or returned by the API.
 */

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Parse a boolean environment variable.
 *
 * `z.coerce.boolean()` uses JavaScript truthiness, so the string "false" would
 * become `true`. Environment variables are always strings, so that helper is
 * unsafe for flags that users set explicitly to `false` (COOKIE_SECURE,
 * SMTP_SECURE). This accepts the common spellings and rejects anything else.
 */
function booleanFromEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return value; // let Zod reject unrecognised input
  }, z.boolean());
}

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // Database
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required — see .env.example'),

  // Session security — used as a pepper when hashing session/tokens hashes and
  // may sign future state. Must be long and random in production.
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:3000,http://localhost:3001,https://localhost,capacitor://localhost,http://10.0.2.2:3001'),

  // Rate limiting — global
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // Auth rate limiting — stricter bucket for /auth/login & /auth/forgot-password
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // Session cookies
  SESSION_COOKIE_NAME: z.string().min(1).default('apnaschool_sid'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7), // 7 days
  SESSION_REMEMBER_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30), // 30 days
  // In dev this can be forced on to test the Secure flag; in production it is
  // always on regardless of this value.
  COOKIE_SECURE: booleanFromEnv(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // Auth tokens (email verification / password reset)
  TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  // Password policy
  PASSWORD_MIN_LENGTH: z.coerce.number().int().positive().default(8),
  PASSWORD_MAX_LENGTH: z.coerce.number().int().positive().default(128),

  // Account lockout
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MS: z.coerce.number().int().positive().default(15 * 60 * 1000), // 15 min

  // Public base URL used to build links in transactional emails
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  // Email (nodemailer). All optional — when SMTP_HOST is absent the email
  // service runs in "dev/log" mode: it logs the message and captures it in
  // memory (so tests/developers can read the token) but sends nothing.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: booleanFromEnv(false),
  SMTP_FROM: z.string().optional(),

  // Optional local open-source inference endpoint. It is restricted to loopback
  // so application configuration cannot turn the AI route into an SSRF proxy.
  OLLAMA_BASE_URL: z.string().url().refine((value) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname), 'OLLAMA_BASE_URL must point to a local loopback server').optional(),
  OLLAMA_MODEL: z.preprocess((value) => value === '' ? undefined : value, z.string().trim().min(1).max(100).optional()),

  // Secure Super Admin bootstrap (seed only). No default password is committed.
  // If unset, the seed generates a random one and prints it once.
  SEED_SUPER_ADMIN_EMAIL: z.string().email().default('admin@apnaschool.pk'),
  SEED_SUPER_ADMIN_PASSWORD: z.string().min(12).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(
    `Environment validation failed:\n${errors}\n\nCheck backend/.env against backend/.env.example`,
  );
}

export const env = parsed.data;

/**
 * Whether the app is running in production mode.
 */
export const isProduction = env.NODE_ENV === 'production';

// In production, silently capturing password-reset/verification emails in
// process memory is not a functional recovery mechanism. Fail closed instead.
if (isProduction) {
  if (!env.SMTP_HOST?.trim()) {
    throw new Error('SMTP_HOST is required in production so account verification and password recovery can deliver email.');
  }
  const appUrl = new URL(env.APP_BASE_URL);
  if (appUrl.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(appUrl.hostname)) {
    throw new Error('APP_BASE_URL must be a public HTTPS URL in production.');
  }
  const configuredOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (configuredOrigins.length === 0 || configuredOrigins.some((origin) => {
    try { return new URL(origin).protocol !== 'https:'; } catch { return true; }
  })) {
    throw new Error('CORS_ORIGIN must contain valid HTTPS origins in production.');
  }
}

/**
 * Whether the app is running in the test environment.
 */
export const isTest = env.NODE_ENV === 'test';

/**
 * CORS origins parsed from the comma-separated CORS_ORIGIN env var.
 */
export const corsOrigins = env.CORS_ORIGIN.split(',').map((origin) =>
  origin.trim(),
);

/** Apply the same strict origin policy to CORS and CSRF checks. */
export function isCorsOriginAllowed(origin: string): boolean {
  if (corsOrigins.includes(origin)) return true;
  if (isProduction) return false;
  if (origin === 'https://localhost' || origin === 'capacitor://localhost') {
    return true;
  }

  try {
    const parsed = new URL(origin);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== origin
    ) {
      return false;
    }

    return (
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '10.0.2.2'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Whether the session cookie must be marked Secure. Forced on in production.
 */
export const cookieSecure = isProduction ? true : env.COOKIE_SECURE;
