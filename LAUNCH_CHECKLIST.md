# ApnaSchool — Manual E2E launch checklist

**Built by Ranjha Farhan**

Tick only what you verified on the **target** environment.

**Date / environment:** _______________________  
**Operator:** _______________________

## Pre-flight

- [ ] PostgreSQL reachable with production `DATABASE_URL`
- [ ] `backend/.env` on host only (not in git)
- [ ] `NODE_ENV=production`
- [ ] `APP_BASE_URL` public HTTPS
- [ ] `CORS_ORIGIN` exact HTTPS frontend origin(s)
- [ ] SMTP_* set; backend starts (production SMTP gate passed)
- [ ] `npx prisma migrate deploy` OK
- [ ] Seed once under change control (or Super Admin exists)
- [ ] Backend `npm run build && npm start` healthy
- [ ] Frontend production build on HTTPS
- [ ] (Mobile) production API URL set — not `10.0.2.2`

## Super Admin

- [ ] Login with seed admin
- [ ] Password change if required
- [ ] Dashboard loads
- [ ] Create school → `SCH-…` + Principal `PRI-…` + temp password
- [ ] Logout works

## Principal

- [ ] Login with ID/password
- [ ] Forced password change works
- [ ] Create class, teacher, student
- [ ] Guardian verification when testing parent data

## Operations

- [ ] Fee category + structure + invoice + approve + record payment
- [ ] Bulk attendance
- [ ] Homework create + publish
- [ ] Announcement create + publish
- [ ] Exam marks entry + publish results
- [ ] Parent/student see **only published** results; print report card

## Security

- [ ] Other school data not visible (tenant isolation smoke)
- [ ] Logout works

## Mobile (if launching apps)

- [ ] Production API URL set
- [ ] Login on device/emulator

## SMTP

- [ ] Forgot-password email delivered
- [ ] Reset link host matches `APP_BASE_URL`

**Critical path:** ☐ PASS  ☐ FAIL → see `LAUNCH_STATUS.md`
