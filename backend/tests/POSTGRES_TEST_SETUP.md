# Disposable PostgreSQL integration test preparation

## Harness status and safe invocation

A dedicated PostgreSQL Vitest config, runner, and read-only target preflight are present. Real-PostgreSQL integration cases currently exist under `tests/postgres/tenant-security.test.ts` for cross-school access, role rejection, concurrent Principal provisioning, audit rollback, lifecycle row-lock behavior, and fully specified class uniqueness. These cases are written but must not be described as passing until they run against an independently verified and explicitly approved disposable database. Existing in-memory/mock suites remain under the regular Vitest config.

After PostgreSQL test cases are implemented and all approval requirements below are met, invoke them with:

```powershell
npm run test:postgres
```

The runner validates its target configuration before starting Vitest. Vitest global setup then connects read-only and verifies the live database identity and runtime-role privileges before loading tests. It never creates schema, runs migrations, resets, seeds, truncates, or performs setup mutations. A schema that is not already provisioned through a separately reviewed and approved process is a hard stop.

## Current repository state

- Prisma schema: `prisma/schema.prisma`, provider `postgresql`.
- Prisma dependency range in the existing lockfile/package manifest: Prisma 6.x.
- The current source archive contains eight ordered migration directories under `prisma/migrations/`:
  1. `20261027080000_core_foundation`
  2. `20261027090000_school_fee_management`
  3. `20261027110000_homework_submissions`
  4. `20261027130000_academic_timetable`
  5. `20261027130000_exams_marks_report_cards`
  6. `20261027150000_announcements_notifications`
  7. `20261105090000_guardian_verification`
  8. `20261105120000_paper_and_fee_approvals`
- The timetable and exams directories share timestamp `20261027130000`; full-name lexical ordering places `academic_timetable` before `exams_marks_report_cards`. Preserve both directory names.
- `migration_lock.toml` declares `provider = "postgresql"`. The checked-in files are source history only; no database migration status or application is implied.
- Do not fabricate migration history or run `prisma migrate reset`.
- The migration README documents a known schema drift: the announcements migration enforces `Announcement.audienceRoles NOT NULL`, while Prisma 6.12 generated SQL from the current Prisma schema omits that NOT NULL constraint. Preserve the existing SQL constraint and resolve the schema representation deliberately before production.
- Unit/auth integration tests currently use an in-memory Prisma double. Those tests do not prove PostgreSQL row locks, transaction rollback, or concurrency guarantees.

## Safe prerequisites

1. Obtain explicit approval from the database owner for the specific isolated disposable instance/database and planned test writes. Never use production, shared development, or an unknown database.
2. Independently verify the exact URL hostname, server address, port, database name, database OID, owner, runtime user, schema, server major version, existing contents, and initialization state. A `_test` suffix or this code's opt-in flags alone are not evidence of disposability.
3. Provision the schema only through a separately reviewed and authorized process. Because no `prisma/migrations/` history exists, do not fabricate history or apply/baseline migrations as part of test setup.
4. Use a runtime account that is not a superuser, database owner, schema owner, owner-role member, or owner of objects in the target schema; it must have no `CREATEDB`, `CREATEROLE`, database/schema `CREATE`, or table `TRUNCATE` privilege. Use a separate account for any separately approved schema provisioning.
5. Supply the variables below only to the dedicated test process after verification. The three `=1` flags are explicit operator attestations; they do not verify a database by themselves.
6. The runner's read-only identity check must match the independently recorded database identity. Any mismatch is a hard stop before tests execute.
7. Never run `prisma db push`, `prisma migrate reset`, `prisma db seed`, migration-apply commands, global truncation, or broad cleanup as part of this runner.

### Required test-process variables

The runner requires `DATABASE_URL` and all of these variables:

- `APNASCHOOL_POSTGRES_TEST_APPROVED=1`
- `APNASCHOOL_POSTGRES_TEST_ISOLATED=1`
- `APNASCHOOL_POSTGRES_TEST_CONTENTS_VERIFIED=1`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_HOST`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_PORT`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_SERVER_ADDRESS`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE_OID`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_DATABASE_OWNER`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_USER`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_SCHEMA`
- `APNASCHOOL_POSTGRES_TEST_EXPECTED_SERVER_VERSION_MAJOR`

The database, host, port, and user expectations must match the URL. The live preflight checks database name and OID, current/session user, server address and port, owner, schema, PostgreSQL major version, and that the runtime role cannot perform DDL, own target-schema objects, truncate tables, or assume the database owner role. Never print or commit the URL or credentials.

These values are currently unavailable. Do not populate them or run the PostgreSQL runner until the database owner has explicitly approved the target and its isolation/disposable status and contents have been independently verified.

## Nullable class uniqueness

`Class` has `@@unique([schoolId, name, section, academicYear])`, while `section` and `academicYear` are nullable. PostgreSQL's normal unique semantics permit multiple rows with `NULL` in those nullable columns. Before proposing a migration, inspect duplicate groups with null-safe grouping on the disposable copy and a read-only query on any authorized database. Do not delete or rewrite existing records automatically.

A migration choice depends on the confirmed PostgreSQL major version and desired semantics. PostgreSQL 15+ supports unique indexes treating NULL values as equal; older versions can use carefully designed partial/expression unique indexes, but Prisma's schema representation and index introspection compatibility must be verified first. No migration is included because neither the target server version nor existing-data conflict report is available.

## Required real-database coverage still to run and extend

- strict audit failure rolls back user and academic mutations;
- row-lock behavior when a school status changes concurrently with provisioning;
- concurrent attempts to create a second Principal;
- cross-school relation assignment and duplicate-class behavior;
- all status transitions using the actual PostgreSQL schema.

## Executable safety guard

The existing helper `tests/helpers/disposablePostgresGuard.ts` remains a pure URL-shape guard for future destructive test setup. It requires all of the following:

- `APNASCHOOL_ALLOW_DISPOSABLE_POSTGRES_TESTS=1`
- PostgreSQL protocol (`postgres:` or `postgresql:`)
- Non-empty hostname, username, and password
- Exactly one safe database-name path segment; malformed encoding and encoded slash/backslash separators are rejected
- A decoded database name ending in `_test`, with production-like names rejected
- No URL fragment

This is a fail-closed naming/opt-in guard, not proof that the host or database is actually disposable. The new runner has a separate approval/identity guard; it also cannot independently prove the operator's isolation attestation or the database's purpose. Independently verify the host, database owner, privileges, and contents before enabling any test run.

Example for a dedicated disposable database (set only in the test shell/process):

```bash
export DATABASE_URL='postgresql://test_runner:REPLACE_WITH_FAKE_EXAMPLE_PASSWORD@127.0.0.1:55432/apnaschool_phase7_test?schema=public' # documentation example only; not a real credential
export APNASCHOOL_ALLOW_DISPOSABLE_POSTGRES_TESTS=1
psql "$DATABASE_URL" -Atc 'SHOW server_version'
```

The example is documentation only and was not executed here; it is not a runnable test configuration. Never copy a development or production URL into this configuration. No reset, migration, seed, or destructive database command is run by the runner or its read-only identity preflight.
