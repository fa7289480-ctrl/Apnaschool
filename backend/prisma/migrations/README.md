# Prisma migration history

Migration directories are ordered lexically by their timestamped names. The
core foundation migration uses `20261027080000`, before the first feature
migration at `20261027090000`.

The foundation adds the schema objects required by the feature migrations; it
does not alter application authentication, RBAC, school tenant isolation, or
audit logging behavior, and does not add or remove RLS/security policies. The
The five earlier feature migration SQL files remain unchanged. Two later
migrations were added on 2026-11-05:

- `20261105090000_guardian_verification` adds a default-deny guardian flag.
- `20261105120000_paper_and_fee_approvals` adds question-paper versions and
  reviews plus fee-voucher approval state and event history. Existing fee
  invoices are set to `PENDING`, since the database has no trusted record of
  prior Principal approval. A Principal must review them before parent access
  or payment recording is allowed.

These new migrations are checked-in source only; their presence does not mean
they have been applied to any database.

The existing timetable and exams migrations both use timestamp
`20261027130000`. Their full directory names make their order deterministic:
`academic_timetable` sorts before `exams_marks_report_cards`. Keep both existing
migration names and SQL unchanged; do not resolve this tie by renaming either
directory.

The announcements migration intentionally remains unchanged and declares
`Announcement.audienceRoles` `NOT NULL` with an empty-array default. Prisma
6.12's SQL generated from the current schema includes the default but omits
`NOT NULL`. This mismatch is not silently reconciled here: decide the intended
invariant and review an explicit schema/forward-migration approach before
deployment. Do not weaken the existing migration constraint.

The exams migration's SQL-only `CHECK` constraints
`ExamSubject_mark_limits_check`, `ExamMark_absence_marks_check`, and
`ExamGradeBand_percentage_range_check` are preserved. Prisma schema diff checks
do not establish that these constraints exist; verify them separately during
an approved rehearsal.

## Later disposable local PostgreSQL 18 rehearsal

Run from `backend` only after independently provisioning and verifying two
already-existing, separately approved disposable databases on PostgreSQL 18:
the migration target and a distinct shadow database. Confirm each exact
database identity, owner, contents, roles, port, loopback address, and server
major version before setting process-local connection variables. Use only
`127.0.0.1:5432`; never use Supabase or another remote/shared database. Do not
edit `.env` for rehearsal credentials.

The Prisma datasource reads `SHADOW_DATABASE_URL` specifically for shadow
database work. Set both URLs only in the current PowerShell process, after
checking that they target the two independently approved local databases.
Never print the URLs, pass credentialed URLs as command-line arguments, or
reuse a production/shared credential.

### Non-database checks

These commands validate schema/generation or render SQL and do not connect to a
database. Set `DATABASE_URL` and `SHADOW_DATABASE_URL` to harmless local
placeholder URLs in the command process if either variable is missing; do not
use a shared or remote URL merely to satisfy environment parsing.

```powershell
npx prisma validate --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.prisma
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

### Database rehearsal — approval required before shadow writes

The history-to-schema diff below replays the migration history in the shadow
database. It is a database operation and may create, reset, or alter shadow
database contents. Run it only after verifying the exact disposable shadow
database and receiving explicit approval for that operation. Review the
generated SQL; do not apply it automatically.

```powershell
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script
```

Prisma 6.12's generated SQL for `Announcement.audienceRoles` has an empty-array
default but omits `NOT NULL`; the existing announcement migration adds
`NOT NULL`. Preserve the migration constraint. Treat a generated `DROP NOT
NULL` as a known, unresolved discrepancy: do not apply it, and do not treat
that part of the diff as clean. The current Prisma schema does not express this
additional database invariant.

Before the first mutation of the migration target, report the exact verified
database name, owner, endpoint, planned command, expected effects, and
remaining risks, then obtain explicit approval. Only after that approval and
identity verification may the following be run against the exact approved
disposable migration database:

```powershell
npx prisma migrate deploy --schema prisma/schema.prisma
npx prisma migrate status --schema prisma/schema.prisma
```

Do not substitute another target. Do not use `db push`, `migrate reset`, or
seed commands. `migrate status` verifies migration-history status, not live
schema drift. The history-to-schema diff uses the shadow database; it does not
compare the actual migration target to Prisma.

After an approved rehearsal, inspect the target catalog to verify migration
history, expected foreign keys/indexes/defaults, and all three SQL-only exam
constraints: `ExamSubject_mark_limits_check`,
`ExamMark_absence_marks_check`, and `ExamGradeBand_percentage_range_check`.
Verify `Announcement.audienceRoles` remains `NOT NULL` with its empty-array
default. Schema diff alone cannot verify SQL-only checks or establish that the
actual target has no drift.

Built by Ranjha Farhan
