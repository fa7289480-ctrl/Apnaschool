import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/postgres/**/*.test.ts'],
    globalSetup: ['./tests/postgres/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'postgres-integration-test-secret-0123456789abcdef',
      CORS_ORIGIN: 'http://localhost:3000,http://localhost:4173',
      SMTP_HOST: '',
      SEED_SUPER_ADMIN_EMAIL: 'admin@apnaschool.pk',
    },
  },
});
