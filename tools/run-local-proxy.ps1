$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$env:BOZOK_EXCEL_ONLY = "1"
$env:DATABASE_DISABLED = "1"
$env:DASHBOARD_FILE_FALLBACK = "1"
$env:DATABASE_REQUIRED = "0"
$env:REQUIRE_DATABASE = "0"
$env:MOON_CACHE_DATABASE = "0"
$env:BOZOK_DISABLE_TELEGRAM = "0"
$env:TELEGRAM_USE_POLLING = "1"
$env:MOON_AUTOMATION_ENABLED = "1"
$env:ONEDRIVE_CENTER_ENABLED = "1"
$env:ONEDRIVE_CENTER_PRIMARY = "1"
$env:ONEDRIVE_CENTER_DIR = "C:\Users\user\OneDrive\BozokMerkez"
$env:ONEDRIVE_SYNC_MIN_MS = "100"
$env:EXCEL_CENTER_ENABLED = "0"
$env:EXCEL_CENTER_PRIMARY = "0"

node proxy-server.js
