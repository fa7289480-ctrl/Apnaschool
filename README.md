# ApnaSchool — Development and Production Guide

This repository is the existing ApnaSchool project. Keep the existing `backend/` and `metis_work/` layout; do not rebuild it from scratch.

**Built by Ranjha Farhan**

## Stack

- Backend: Node.js, Express 4, TypeScript, Prisma 6.x, PostgreSQL.
- Frontend: Vite, Bootstrap, Alpine.js, HTML, JavaScript, and SCSS in `metis_work/src-modern/`.
- Mobile: Capacitor apps under `mobile/` (principal, teacher, parent, student, super-admin).
- Backend tests: Vitest (+ optional guarded PostgreSQL harness).

---

## Production runbook (launch day)

### 0. What you must provide manually (secrets never in this repo)

| Item | Notes |
|------|--------|
| `DATABASE_URL` | Production PostgreSQL; percent-encode special characters |
| `SESSION_SECRET` | ≥32 random characters |
| HTTPS web domain | `APP_BASE_URL` + `CORS_ORIGIN` |
| API HTTPS origin | Mobile / optional `VITE_API_URL` / meta tag |
| SMTP credentials | Required in production for verify + password reset |
| Super Admin seed | Email (+ optional password); rotate after first login |

**Never commit `backend/.env`.**

### 1–5. Commands

```bash
# Database: create empty DB + restricted role, confirm backups

cd backend
cp .env.example .env
# Set production values:
# NODE_ENV=production
# DATABASE_URL=...
# SESSION_SECRET=...
# APP_BASE_URL=https://app.example.com
# CORS_ORIGIN=https://app.example.com
# COOKIE_SECURE=true
# SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM / SMTP_SECURE

npm ci
npx prisma generate
npx prisma migrate deploy
npm run db:seed          # once, controlled
npm run build && npm start

cd ../metis_work
npm ci
# export VITE_API_URL=https://api.example.com   # if API origin differs
npm run build
# Serve dist over HTTPS at APP_BASE_URL
```

Production startup **refuses** to boot without SMTP_HOST and public HTTPS APP_BASE_URL / CORS_ORIGIN.

### SMTP test

1. Configure SMTP_* and restart backend.
2. Use `forgot-password.html` with a real user email.
3. Confirm inbox + reset link host matches `APP_BASE_URL`.

### API base URL (web + mobile)

Order in `metis_work/src-modern/scripts/utils/api-client.js`:

1. `window.APNASCHOOL_SERVER_URL`
2. `localStorage.APNASCHOOL_SERVER_URL`
3. `<meta name="apnaschool-api-base" content="https://api.example.com">`
4. Web: `VITE_API_URL`
5. Web fallback: same-origin relative `/api/...`
6. Native emulator only: `http://10.0.2.2:3001` — **never ship on physical device**

### Local development

```bash
cd backend && cp .env.example .env && npm ci && npx prisma generate && npx prisma migrate deploy && npm run db:seed && npm run dev
cd metis_work && npm ci && npm run dev
```

## Launch docs

- `LAUNCH_CHECKLIST.md` — manual E2E tick boxes
- `LAUNCH_STATUS.md` — GO / NO-GO (currently NO-GO until you run target migrate + checklist)
- `NOT_IMPLEMENTED.md` — deferred gaps (Accountant, multi-guardian, payment gateway, etc.)
- `PACKAGE_CONTENTS.md` — what is inside this ZIP

This README is **not** a claim that production is already live.
