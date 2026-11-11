import { isIP } from 'node:net';

export interface PostgresTestTarget {
  databaseUrl: string;
  database: string;
  host: string;
  port: number;
  serverAddress: string;
  databaseOid: string;
  databaseOwner: string;
  user: string;
  schema: string;
  serverVersionMajor: number;
}

export interface PostgresTestIdentity {
  database: string;
  user: string;
  sessionUser: string;
  serverAddress: string | null;
  serverPort: number | null;
  databaseOid: string;
  databaseOwner: string;
  schema: string | null;
  serverVersionNum: number;
  isSuperuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  canCreateInDatabase: boolean;
  canCreateInSchema: boolean;
  memberOfDatabaseOwner: boolean;
  ownsSchemaObjects: boolean;
  canTruncateTables: boolean;
}

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`PostgreSQL tests require ${name}.`);
  return value;
}

function positiveInteger(value: string, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function getPostgresTestTarget(environment: Environment): PostgresTestTarget {
  if (environment.APNASCHOOL_POSTGRES_TEST_APPROVED !== '1') {
    throw new Error('PostgreSQL tests require explicit APNASCHOOL_POSTGRES_TEST_APPROVED=1 approval.');
  }
  if (environment.APNASCHOOL_POSTGRES_TEST_ISOLATED !== '1') {
    throw new Error('PostgreSQL tests require explicit confirmation that the target is isolated and disposable.');
  }
  if (environment.APNASCHOOL_POSTGRES_TEST_CONTENTS_VERIFIED !== '1') {
    throw new Error('PostgreSQL tests require confirmation that the target contents and identity were independently verified.');
  }

  const databaseUrl = required(environment, 'DATABASE_URL');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('PostgreSQL tests require a valid DATABASE_URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL tests require a PostgreSQL DATABASE_URL.');
  }
  if (!url.hostname || !url.username || !url.password || url.hash) {
    throw new Error('PostgreSQL test DATABASE_URL must include a host and credentials and must not include a fragment.');
  }

  const rawDatabase = url.pathname.slice(1);
  if (!rawDatabase || rawDatabase.includes('/') || /%(?:2f|5c)/i.test(rawDatabase)) {
    throw new Error('PostgreSQL test DATABASE_URL must identify exactly one database.');
  }

  let databaseFromUrl: string;
  try {
    databaseFromUrl = decodeURIComponent(rawDatabase);
  } catch {
    throw new Error('PostgreSQL test DATABASE_URL contains invalid database-name encoding.');
  }
  if (!databaseFromUrl || databaseFromUrl.includes('/') || databaseFromUrl.includes('\\')) {
    throw new Error('PostgreSQL test DATABASE_URL contains an unsafe database name.');
  }

  const database = required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE');
  if (database !== databaseFromUrl) {
    throw new Error('Expected PostgreSQL test database does not match DATABASE_URL.');
  }
  if (!database.toLowerCase().endsWith('_test') || /(^|[_-])(prod(?:uction)?|live)([_-]|$)/i.test(database)) {
    throw new Error('PostgreSQL test database must be an explicitly approved non-production _test database.');
  }

  const host = required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_HOST');
  if (host.toLowerCase() !== url.hostname.toLowerCase()) {
    throw new Error('Expected PostgreSQL test host does not match DATABASE_URL.');
  }

  const portFromUrl = url.port ? positiveInteger(url.port, 'DATABASE_URL port', 65535) : 5432;
  const port = positiveInteger(
    required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_PORT'),
    'APNASCHOOL_POSTGRES_TEST_EXPECTED_PORT',
    65535,
  );
  if (port !== portFromUrl) throw new Error('Expected PostgreSQL test port does not match DATABASE_URL.');

  const schema = required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_SCHEMA');
  const schemaFromUrl = url.searchParams.get('schema') ?? 'public';
  if (schema !== schemaFromUrl) throw new Error('Expected PostgreSQL test schema does not match DATABASE_URL.');

  const serverAddress = required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_SERVER_ADDRESS');
  if (!isIP(serverAddress)) throw new Error('Expected PostgreSQL server address must be a verified IP address.');

  let user: string;
  try {
    user = decodeURIComponent(url.username);
  } catch {
    throw new Error('PostgreSQL test DATABASE_URL contains invalid username encoding.');
  }
  if (user !== required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_USER')) {
    throw new Error('Expected PostgreSQL test user does not match DATABASE_URL.');
  }
  const databaseOwner = required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE_OWNER');
  if (databaseOwner === user) {
    throw new Error('PostgreSQL test runtime user must not own the database.');
  }

  return {
    databaseUrl,
    database,
    host: url.hostname,
    port,
    serverAddress,
    databaseOid: positiveInteger(
      required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE_OID'),
      'APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE_OID',
    ).toString(),
    databaseOwner,
    user,
    schema,
    serverVersionMajor: positiveInteger(
      required(environment, 'APNASCHOOL_POSTGRES_TEST_EXPECTED_SERVER_VERSION_MAJOR'),
      'APNASCHOOL_POSTGRES_TEST_EXPECTED_SERVER_VERSION_MAJOR',
    ),
  };
}

export function assertPostgresTestIdentity(
  target: PostgresTestTarget,
  identity: PostgresTestIdentity,
): void {
  const mismatches: string[] = [];
  if (identity.database !== target.database) mismatches.push('database');
  if (identity.user !== target.user) mismatches.push('runtime user');
  if (identity.sessionUser !== target.user) mismatches.push('session user');
  if (identity.serverAddress !== target.serverAddress) mismatches.push('server address');
  if (identity.serverPort !== target.port) mismatches.push('server port');
  if (identity.databaseOid !== target.databaseOid) mismatches.push('database OID');
  if (identity.databaseOwner !== target.databaseOwner) mismatches.push('database owner');
  if (identity.schema !== target.schema) mismatches.push('schema');

  const actualMajor = Math.floor(identity.serverVersionNum / 10_000);
  if (actualMajor !== target.serverVersionMajor) mismatches.push('PostgreSQL major version');

  if (identity.isSuperuser) mismatches.push('superuser privilege');
  if (identity.canCreateDatabase) mismatches.push('CREATEDB privilege');
  if (identity.canCreateRole) mismatches.push('CREATEROLE privilege');
  if (identity.canCreateInDatabase) mismatches.push('database CREATE privilege');
  if (identity.canCreateInSchema) mismatches.push('schema CREATE privilege');
  if (identity.memberOfDatabaseOwner) mismatches.push('database-owner role membership');
  if (identity.ownsSchemaObjects) mismatches.push('ownership of target-schema objects');
  if (identity.canTruncateTables) mismatches.push('TRUNCATE privilege');
  if (identity.databaseOwner === identity.user) mismatches.push('runtime user owns database');

  if (mismatches.length > 0) {
    throw new Error(`PostgreSQL test target verification failed: ${mismatches.join(', ')} did not match the approved target.`);
  }
}
