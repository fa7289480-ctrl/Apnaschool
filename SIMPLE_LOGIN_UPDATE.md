# Simple Login UI — 2026-11-10

## What changed
- Login screen is now ID + Password only (no email-focused label).
- Removed Google / GitHub buttons.
- Removed "Create an account" link from login page.
- Labels and messages simplified (Urdu/English mix for clarity).
- Same change applied to web (`metis_work/src-modern/login.html`) and all five mobile app login pages.

## How users log in
| Role | Example ID |
|------|------------|
| Super Admin | ADM-0001 |
| Principal | PRI-0001 |
| Teacher | TCH-0001 |
| Student | STU-0001 |
| Parent | PAR-0001 |

Backend still accepts email OR public ID OR username; UI now emphasizes ID only.

## Files touched
- metis_work/src-modern/login.html
- metis_work/src-modern/scripts/components/auth.js
- mobile/*/www/login.html
- mobile/*/android/app/src/main/assets/public/login.html
