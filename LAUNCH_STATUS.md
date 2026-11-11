# ApnaSchool — Launch status (GO / NO-GO)

**Built by Ranjha Farhan**  
**Package date:** 2026-11-10

## Verdict: **NO-GO** until operator completes target checks

Code includes production gates (SMTP + HTTPS `APP_BASE_URL` / `CORS_ORIGIN` when `NODE_ENV=production`).  
This environment has **not** run migrate/seed/E2E against your live database.

### GO only if all true on target

- [ ] `prisma migrate deploy` success
- [ ] Seed Super Admin can login
- [ ] `LAUNCH_CHECKLIST.md` critical path all pass
- [ ] SMTP tested **or** written risk acceptance (note: production process will not start without SMTP)
- [ ] HTTPS + CORS correct
- [ ] No tenant leak in smoke test

### Automatic NO-GO

DB unreachable · login broken · tenant leak · required env missing · mobile still on `10.0.2.2`

### Intentionally deferred (v1)

Accountant/Receptionist · payment gateway · multi-guardian · report-card DOCX · Play keystore · AI without Ollama

### Morning commands

```bash
cd backend
cp -n .env.example .env   # fill real secrets
npm ci && npx prisma generate && npx prisma migrate deploy
npm run db:seed           # once if needed
npm run build && npm start

cd ../metis_work
npm ci && npm run build   # optional VITE_API_URL=https://api.YOUR_DOMAIN
# deploy dist to HTTPS
```

### You must supply

`DATABASE_URL`, `SESSION_SECRET`, HTTPS domains, SMTP, seed admin credentials decision, mobile API URL/keystore if shipping apps.
