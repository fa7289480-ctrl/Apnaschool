$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$WebDist = Join-Path $Root 'metis_work\dist-modern'
if ($env:APNASCHOOL_WEB_DIST) {
    $WebDist = $env:APNASCHOOL_WEB_DIST
}

if (-not (Test-Path $WebDist)) {
    Write-Host 'Building existing ApnaSchool web UI...'
    Push-Location (Join-Path $Root 'metis_work')
    try { npm ci; npm run build } finally { Pop-Location }
}
if (-not (Test-Path $WebDist)) { throw "Missing build output: $WebDist" }

$roles = @(
    @{
        Name='super-admin'; Entry='index.html'
        Pages=@('index.html','login.html','forgot-password.html','reset-password.html','verify-email.html','change-password.html')
    },
    @{
        Name='principal'; Entry='principal-dashboard.html'
        Pages=@('principal-dashboard.html','attendance.html','fees.html','exams.html','homework.html','announcements.html','guardian-verification.html','login.html','register.html','forgot-password.html','reset-password.html','verify-email.html','change-password.html')
    },
    @{
        Name='teacher'; Entry='teacher-dashboard.html'
        Pages=@('teacher-dashboard.html','attendance.html','homework.html','exams.html','paper-maker.html','timetable.html','announcements.html','login.html','forgot-password.html','reset-password.html','verify-email.html','change-password.html')
    },
    @{
        Name='parent'; Entry='parent-dashboard.html'
        Pages=@('parent-dashboard.html','my-homework.html','my-results.html','my-fees.html','timetable.html','announcements.html','login.html','forgot-password.html','reset-password.html','verify-email.html','change-password.html')
    },
    @{
        Name='student'; Entry='student-dashboard.html'
        Pages=@('student-dashboard.html','my-homework.html','my-results.html','my-fees.html','timetable.html','announcements.html','login.html','forgot-password.html','reset-password.html','verify-email.html','change-password.html')
    }
)
foreach ($r in $roles) {
    $out = Join-Path $Root "mobile\$($r.Name)\www"
    if (-not (Test-Path $out)) {
        New-Item -ItemType Directory -Path $out -Force | Out-Null
    }
    foreach ($existingPage in (Get-ChildItem -Path $out -File -Recurse -Filter '*.html')) {
        $relative = $existingPage.FullName.Substring($out.Length).TrimStart('\')
        if ($relative -ne 'index.html' -and $relative -notin $r.Pages) {
            Remove-Item -LiteralPath $existingPage.FullName -Force
        }
    }
    foreach ($source in (Get-ChildItem -Path $WebDist -File -Recurse)) {
        $relative = $source.FullName.Substring($WebDist.Length).TrimStart('\')
        if ($source.Extension -eq '.html' -and $relative -notin $r.Pages) { continue }
        $destination = Join-Path $out $relative
        $destinationDirectory = Split-Path -Parent $destination
        if (-not (Test-Path $destinationDirectory)) {
            New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        }
        Copy-Item $source.FullName $destination -Force
    }
    $entry = Join-Path $out $r.Entry
    if (-not (Test-Path $entry)) { throw "Missing role entry: $entry" }
    if ($r.Entry -ne 'index.html') {
        Copy-Item $entry (Join-Path $out 'index.html') -Force
    }
    Set-Content -Path (Join-Path $out '.apnaschool-mobile') -Value "ApnaSchool $($r.Name) mobile shell"
}
Write-Host 'Role-scoped mobile web assets synced successfully.'
Write-Host 'Next: cd mobile\<role>; npm ci; npx cap add android; npx cap sync android'
