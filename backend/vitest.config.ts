import { defineConfig } from 'vitest/config';

/**
 * Auth tests run against an in-memory Prisma double (tests/fake-prisma.ts), so
 * they never touch a real PostgreSQL database. These env values are applied
 * before the app imports src/config/env.ts.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tests/postgres/**'],
    // The auth rate limiter is deliberately strict in production; tests issue
    // many requests from one IP, so raise the buckets for the test run only.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        'postgresql://test_user:fake_password@127.0.0.1:5432/apnaschool_test?schema=public',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
      CORS_ORIGIN: 'http://localhost:3000,http://localhost:4173',
      RATE_LIMIT_WINDOW_MS: '900000',
      RATE_LIMIT_MAX: '10000',
      AUTH_RATE_LIMIT_WINDOW_MS: '900000',
      AUTH_RATE_LIMIT_MAX: '1000',
      SESSION_COOKIE_NAME: 'apnaschool_sid',
      SESSION_TTL_SECONDS: '604800',
      SESSION_REMEMBER_TTL_SECONDS: '2592000',
      COOKIE_SECURE: 'false',
      COOKIE_SAMESITE: 'lax',
      TOKEN_TTL_MINUTES: '30',
      PASSWORD_MIN_LENGTH: '8',
      PASSWORD_MAX_LENGTH: '128',
      LOGIN_MAX_ATTEMPTS: '3',
      LOGIN_LOCKOUT_MS: '60000',
      APP_BASE_URL: 'http://localhost:3000',
      // Force the in-process/log email transport: tests must never send mail,
      // even if the developer's local .env has SMTP configured.
      SMTP_HOST: '',
      SEED_SUPER_ADMIN_EMAIL: 'admin@apnaschool.pk',
    },
  },
});
