#!/usr/bin/env bash
# Build the existing ApnaSchool web UI, then package role-specific copies for
# each mobile app. The source project is never rebuilt or replaced.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_DIST="$ROOT/metis_work/dist-modern"

if [[ ! -d "$WEB_DIST" ]]; then
  echo "Building web UI first..."
  (cd "$ROOT/metis_work" && npm ci && npm run build)
fi
[[ -d "$WEB_DIST" ]] || { echo "ERROR: $WEB_DIST not found after build."; exit 1; }

roles=(super-admin principal teacher parent student)
entries=(index.html principal-dashboard.html teacher-dashboard.html parent-dashboard.html student-dashboard.html)
for i in "${!roles[@]}"; do
  role="${roles[$i]}"; entry="${entries[$i]}"; out="$ROOT/mobile/$role/www"
  rm -rf "$out"; mkdir -p "$out"; cp -a "$WEB_DIST"/. "$out"/
  if [[ -f "$out/$entry" ]]; then cp "$out/$entry" "$out/index.html"; else echo "ERROR: missing $entry for $role"; exit 1; fi
  printf 'ApnaSchool %s mobile shell\n' "$role" > "$out/.apnaschool-mobile"
done

echo "Synced role-scoped web build into: mobile/{super-admin,principal,teacher,parent,student}/www"
echo "Android generation/build: cd mobile/<role> && npm ci && npx cap add android && npx cap sync android"
