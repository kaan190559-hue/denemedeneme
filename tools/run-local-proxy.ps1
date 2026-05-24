$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$env:BOZOK_DISABLE_TELEGRAM = "1"
$env:ONEDRIVE_CENTER_ENABLED = "1"
$env:ONEDRIVE_CENTER_PRIMARY = "0"
$env:ONEDRIVE_CENTER_DIR = "C:\Users\user\OneDrive\BozokMerkez"
$env:ONEDRIVE_SYNC_MIN_MS = "500"

node proxy-server.js
