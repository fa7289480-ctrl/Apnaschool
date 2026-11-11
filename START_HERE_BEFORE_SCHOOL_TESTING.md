# ApnaSchool — Start here before school testing

This package contains the complete project copy plus the current PostgreSQL test-fixture URL correction and the current source verification report.

## Current source inventory

- Backend routes present: auth, users, academic setup, Super Admin lifecycle, role portals, attendance, fees, homework, exams, timetable, and announcements.
- Prisma schema: 33 models and 14 enums.
- Checked-in migration files: 6, including a core foundation migration followed by feature migrations.
- Static checks in this environment: 66/66 TypeScript files passed syntax/transpilation; 38/38 frontend JavaScript files passed `node --check`; schema/model/table/enum names and migration FK ordering passed static comparison.
- These are source-level checks only. They do **not** prove full typecheck, runtime tests, browser behavior, or PostgreSQL migration replay.

## Before a real school pilot

1. Extract this ZIP into a new folder; keep your current project and backups unchanged.
2. Follow the exact verification sequence in `CURRENT_VERIFICATION_REPORT_2026-10-29.md`.
3. Rehearse all migrations against a new, verified disposable PostgreSQL database and review the resulting schema before any production decision.
4. Do not run `prisma migrate deploy`, `prisma db push`, `prisma migrate reset`, or seed against Supabase or any real school database yet.
5. Do not call this production-ready until backend tests/typecheck/build/lint, frontend build/browser/auth tests, security audits, and disposable-PostgreSQL integration checks have passed.

The local Windows project folder is not changed by this ZIP. No database was connected to or modified while preparing this package.
