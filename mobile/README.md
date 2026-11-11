# ApnaSchool mobile channel policy

## Access model

| Role | Web portal | Mobile app |
|---|---|---|
| Super Admin | Yes | Yes |
| Principal / SCHOOL_ADMIN | Yes | Yes |
| Teacher | No | Yes |
| Parent | No | Yes |
| Student | No | Yes |

Teacher, Parent and Student are explicitly blocked from the web portal after authentication and on direct page loads. Their API permissions remain server-side and are not weakened.

Super Admin and Principal remain usable on both web and mobile.

## Android projects

The source contains five separate Capacitor apps with existing Android projects
and Gradle wrappers:

- `mobile/super-admin`
- `mobile/principal`
- `mobile/teacher`
- `mobile/parent`
- `mobile/student`

Do not run `cap add android` for these projects; that command is only for a role
whose `android/` directory does not exist. Each app uses the shared web client
and backend API configuration.

```powershell
cd mobile\teacher
npm run sync
cd android
.\gradlew.bat assembleDebug
```

Repeat the sync and build steps for `super-admin`, `principal`, `teacher`,
`parent`, and `student`. Debug APKs are written to each app's
`android\app\build\outputs\apk\debug\` directory. A compatible JDK and Android
SDK must be installed.

## Build web assets first

From PowerShell, run:

```powershell
bash mobile/scripts/sync-web.sh
```

or run the equivalent commands on Windows Git Bash/WSL. The Windows PowerShell
sync script copies shared non-HTML assets and only the selected role's
allowlisted HTML pages, then sets that role's dashboard as `index.html`. It
removes stale, non-allowlisted HTML files from that role's `www` directory but
preserves the directory and its other files. The existing APKs are not changed
until the role is synced into its Android project and rebuilt.

### Windows PowerShell

Use `mobile\scripts\sync-web.ps1` instead of the Bash script on Windows, then
run `npm run sync` from each role app to copy the generated web assets into its
native Android project.

The Android emulator default API address is `http://10.0.2.2:3001`. Physical
devices and production builds need a reachable backend URL; configure it with
the `APNASCHOOL_SERVER_URL` local-storage key or the
`window.APNASCHOOL_SERVER_URL` override. The web portal uses same-origin `/api`
requests (Vite proxies to `http://localhost:3001` in development).

Built by Ranjha Farhan
