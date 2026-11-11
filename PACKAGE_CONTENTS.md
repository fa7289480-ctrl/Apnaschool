# ApnaSchool full project package (cleaned)

**Built by Ranjha Farhan**

## Included

- `backend/` — Express + TypeScript + Prisma + PostgreSQL API
- `metis_work/` — Web frontend (role dashboards + school modules)
- `mobile/` — Capacitor apps (principal, teacher, parent, student, super-admin)
- `previews/` — ApnaSchool dashboard screenshots
- Launch docs: `README.md`, `LAUNCH_CHECKLIST.md`, `LAUNCH_STATUS.md`, `NOT_IMPLEMENTED.md`, `START_HERE_BEFORE_SCHOOL_TESTING.md`, `SIMPLE_LOGIN_UPDATE.md`, `backend/.env.example`

## Cleaned out of this package (useless for running/shipping)

- 70+ historical `APNASCHOOL_*` / `PHASE*` / `SUPABASE_*` checkpoint, migration-review, and verification markdown reports (development history only)
- `metis_work/screenshots/` third-party theme marketing images (admindek, cryptocurrency, etc.)
- No `node_modules`, no real `.env`, no secrets

## Intentionally kept (not removed)

- Metis template demo HTML pages (`products.html`, `elements-*.html`, etc.) still referenced by Vite build inputs — removing them needs a separate frontend trim pass
- Mobile `www` + Android assets (required for Capacitor apps)

## After extract

```bash
cd backend && cp .env.example .env   # fill secrets
npm ci && npx prisma generate && npx prisma migrate deploy
cd ../metis_work && npm ci
```

See `README.md` and `LAUNCH_STATUS.md` (NO-GO until your migrate + checklist).
