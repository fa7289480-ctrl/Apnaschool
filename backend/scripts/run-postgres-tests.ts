import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPostgresTestTarget } from '../tests/helpers/postgresTestTarget.js';

try {
  getPostgresTestTarget(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'PostgreSQL test target configuration is invalid.');
  process.exit(1);
}

const backendRoot = fileURLToPath(new URL('../', import.meta.url));
const postgresTests = resolve(backendRoot, 'tests/postgres');
const hasIntegrationTests = readdirSync(postgresTests, { recursive: true })
  .some((entry) => typeof entry === 'string' && entry.endsWith('.test.ts'));
if (!hasIntegrationTests) {
  console.error('No real PostgreSQL integration tests are implemented under tests/postgres/. No database connection was attempted.');
  process.exit(1);
}

const vitestCli = resolve(backendRoot, 'node_modules/vitest/vitest.mjs');
const config = resolve(backendRoot, 'vitest.postgres.config.ts');
const result = spawnSync(process.execPath, [vitestCli, 'run', '--config', config], {
  cwd: backendRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Could not start the PostgreSQL Vitest runner: ${result.error.message}`);
  process.exit(1);
}

process.exitCode = result.status ?? 1;
