import { describe, expect, it } from 'vitest';
import {
  assertPostgresTestIdentity,
  getPostgresTestTarget,
  type PostgresTestIdentity,
} from './helpers/postgresTestTarget.js';

function approvedEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    APNASCHOOL_POSTGRES_TEST_APPROVED: '1',
    APNASCHOOL_POSTGRES_TEST_ISOLATED: '1',
    APNASCHOOL_POSTGRES_TEST_CONTENTS_VERIFIED: '1',
    DATABASE_URL: 'postgresql://test_runner:fake_password@127.0.0.1:55432/apnaschool_phase7_test?schema=public',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE: 'apnaschool_phase7_test',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_HOST: '127.0.0.1',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_PORT: '55432',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_SERVER_ADDRESS: '127.0.0.1',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE_OID: '16384',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE_OWNER: 'test_owner',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_USER: 'test_runner',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_SCHEMA: 'public',
    APNASCHOOL_POSTGRES_TEST_EXPECTED_SERVER_VERSION_MAJOR: '16',
    ...overrides,
  };
}

function identity(overrides: Partial<PostgresTestIdentity> = {}): PostgresTestIdentity {
  return {
    database: 'apnaschool_phase7_test',
    user: 'test_runner',
    sessionUser: 'test_runner',
    serverAddress: '127.0.0.1',
    serverPort: 55432,
    databaseOid: '16384',
    databaseOwner: 'test_owner',
    schema: 'public',
    serverVersionNum: 160004,
    isSuperuser: false,
    canCreateDatabase: false,
    canCreateRole: false,
    canCreateInDatabase: false,
    canCreateInSchema: false,
    memberOfDatabaseOwner: false,
    ownsSchemaObjects: false,
    canTruncateTables: false,
    ...overrides,
  };
}

describe('PostgreSQL test-target configuration guard', () => {
  it('requires explicit approval, isolation, and independent identity/content verification', () => {
    const environment = approvedEnvironment();
    for (const name of [
      'APNASCHOOL_POSTGRES_TEST_APPROVED',
      'APNASCHOOL_POSTGRES_TEST_ISOLATED',
      'APNASCHOOL_POSTGRES_TEST_CONTENTS_VERIFIED',
    ]) {
      const unapproved = { ...environment, [name]: undefined };
      expect(() => getPostgresTestTarget(unapproved)).toThrow();
    }
  });

  it('does not treat a _test suffix as evidence of approval or disposability', () => {
    expect(() =>
      getPostgresTestTarget({
        DATABASE_URL: 'postgresql://test_runner:fake_password@127.0.0.1:55432/apnaschool_phase7_test?schema=public',
      }),
    ).toThrow(/explicit APNASCHOOL_POSTGRES_TEST_APPROVED/);
  });

  it('requires the independently recorded target identity and compares it with the URL', () => {
    expect(() =>
      getPostgresTestTarget(approvedEnvironment({
        APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE_OID: undefined,
      })),
    ).toThrow(/EXPECTED_DATABASE_OID/);
    expect(() =>
      getPostgresTestTarget(approvedEnvironment({
        APNASCHOOL_POSTGRES_TEST_EXPECTED_HOST: 'other.example',
      })),
    ).toThrow(/host does not match/);
    expect(() =>
      getPostgresTestTarget(approvedEnvironment({
        DATABASE_URL: 'postgresql://test_runner:fake_password@127.0.0.1:55432/apnaschool_other_test?schema=public',
      })),
    ).toThrow(/database does not match/);
  });

  it('rejects unsafe, production-like, malformed, or incomplete targets', () => {
    expect(() =>
      getPostgresTestTarget(approvedEnvironment({
        APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE: 'apnaschool_prod_test',
        DATABASE_URL: 'postgresql://test_runner:fake_password@127.0.0.1:55432/apnaschool_prod_test?schema=public',
      })),
    ).toThrow(/non-production/);
    expect(() =>
      getPostgresTestTarget(approvedEnvironment({
        DATABASE_URL: 'postgresql://test_runner:fake_password@127.0.0.1:55432/apnaschool_test/prod?schema=public',
        APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE: 'apnaschool_test/prod',
      })),
    ).toThrow(/exactly one database/);
    expect(() =>
      getPostgresTestTarget(approvedEnvironment({
        APNASCHOOL_POSTGRES_TEST_EXPECTED_SERVER_ADDRESS: 'db.example',
      })),
    ).toThrow(/IP address/);
  });

  it('accepts an explicitly approved target configuration without connecting', () => {
    const target = getPostgresTestTarget(approvedEnvironment());
    expect(target).toMatchObject({
      database: 'apnaschool_phase7_test',
      host: '127.0.0.1',
      port: 55432,
      serverAddress: '127.0.0.1',
      databaseOid: '16384',
      databaseOwner: 'test_owner',
      user: 'test_runner',
      schema: 'public',
      serverVersionMajor: 16,
    });
    expect(target.databaseUrl).toContain('fake_password');
  });
});

describe('PostgreSQL read-only identity verification', () => {
  it('accepts only an exact identity match with a restricted runtime role', () => {
    const target = getPostgresTestTarget(approvedEnvironment());
    expect(() => assertPostgresTestIdentity(target, identity())).not.toThrow();
  });

  it.each([
    ['database', { database: 'another_test' }],
    ['runtime user', { user: 'other_user' }],
    ['session user', { sessionUser: 'other_user' }],
    ['server address', { serverAddress: '127.0.0.2' }],
    ['server port', { serverPort: 5432 }],
    ['database OID', { databaseOid: '16385' }],
    ['database owner', { databaseOwner: 'other_owner' }],
    ['schema', { schema: 'other_schema' }],
    ['PostgreSQL major version', { serverVersionNum: 150000 }],
    ['superuser privilege', { isSuperuser: true }],
    ['CREATEDB privilege', { canCreateDatabase: true }],
    ['CREATEROLE privilege', { canCreateRole: true }],
    ['database CREATE privilege', { canCreateInDatabase: true }],
    ['schema CREATE privilege', { canCreateInSchema: true }],
    ['database-owner role membership', { memberOfDatabaseOwner: true }],
    ['ownership of target-schema objects', { ownsSchemaObjects: true }],
    ['TRUNCATE privilege', { canTruncateTables: true }],
  ] as const)('fails closed for a mismatched %s', (_name, override) => {
    const target = getPostgresTestTarget(approvedEnvironment());
    expect(() => assertPostgresTestIdentity(target, identity(override))).toThrow(/verification failed/);
  });
});
