import { PrismaClient } from '@prisma/client';
import {
  assertPostgresTestIdentity,
  getPostgresTestTarget,
  type PostgresTestIdentity,
} from '../helpers/postgresTestTarget.js';

export default async function verifyPostgresTestTarget(): Promise<void> {
  const target = getPostgresTestTarget(process.env);
  const prisma = new PrismaClient({ datasources: { db: { url: target.databaseUrl } } });

  try {
    await prisma.$connect();
    const identities = await prisma.$queryRaw<PostgresTestIdentity[]>`
      SELECT
        current_database() AS "database",
        current_user::text AS "user",
        session_user::text AS "sessionUser",
        inet_server_addr()::text AS "serverAddress",
        inet_server_port() AS "serverPort",
        d.oid::text AS "databaseOid",
        pg_get_userbyid(d.datdba) AS "databaseOwner",
        current_schema() AS "schema",
        current_setting('server_version_num')::int AS "serverVersionNum",
        r.rolsuper AS "isSuperuser",
        r.rolcreatedb AS "canCreateDatabase",
        r.rolcreaterole AS "canCreateRole",
        has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateInDatabase",
        has_schema_privilege(current_user, current_schema(), 'CREATE') AS "canCreateInSchema",
        pg_has_role(current_user, d.datdba, 'MEMBER') AS "memberOfDatabaseOwner",
        (
          pg_get_userbyid(n.nspowner) = current_user
          OR EXISTS (
            SELECT 1 FROM pg_class AS c
            WHERE c.relnamespace = n.oid AND c.relowner = r.oid
          )
          OR EXISTS (
            SELECT 1 FROM pg_proc AS p
            WHERE p.pronamespace = n.oid AND p.proowner = r.oid
          )
          OR EXISTS (
            SELECT 1 FROM pg_type AS t
            WHERE t.typnamespace = n.oid AND t.typowner = r.oid
          )
          OR EXISTS (
            SELECT 1 FROM pg_extension AS e
            WHERE e.extnamespace = n.oid AND e.extowner = r.oid
          )
        ) AS "ownsSchemaObjects",
        EXISTS (
          SELECT 1 FROM pg_class AS c
          WHERE c.relnamespace = n.oid
            AND c.relkind IN ('r', 'p')
            AND has_table_privilege(current_user, c.oid, 'TRUNCATE')
        ) AS "canTruncateTables"
      FROM pg_database AS d
      JOIN pg_roles AS r ON r.rolname = current_user
      JOIN pg_namespace AS n ON n.nspname = current_schema()
      WHERE d.datname = current_database()
    `;
    if (identities.length !== 1) {
      throw new Error('PostgreSQL test target verification failed: database identity could not be established.');
    }
    assertPostgresTestIdentity(target, identities[0]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PostgreSQL test target verification failed:')) {
      throw error;
    }
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? ` (database error code ${error.code})`
        : '';
    throw new Error(`PostgreSQL read-only target preflight failed${code}; connection details are withheld.`);
  } finally {
    await prisma.$disconnect();
  }
}
