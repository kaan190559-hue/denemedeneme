param(
  [string]$CenterDir = "",
  [int]$Port = 8787,
  [switch]$NoExcelWatcher
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (!$CenterDir) {
  if ($env:OneDrive) {
    $CenterDir = Join-Path $env:OneDrive "BozokMerkez"
  } else {
    $CenterDir = Join-Path $env:USERPROFILE "OneDrive\BozokMerkez"
  }
}

if (!(Test-Path $CenterDir)) {
  New-Item -ItemType Directory -Force -Path $CenterDir | Out-Null
}

$WorkbookPath = Join-Path $CenterDir "BozokMerkez.xlsx"

# Excel merkez modu: Render/Postgres ana kayıt değildir. Panel, Moon bot ve Telegram
# aynı OneDrive klasöründeki JSON/CSV kayıtlarından okuyup yazar.
$env:BOZOK_EXCEL_ONLY = "1"
$env:DATABASE_DISABLED = "1"
$env:DASHBOARD_FILE_FALLBACK = "1"
$env:DATABASE_REQUIRED = "0"
$env:REQUIRE_DATABASE = "0"
$env:MOON_CACHE_DATABASE = "0"

$env:ONEDRIVE_CENTER_ENABLED = "1"
$env:ONEDRIVE_CENTER_PRIMARY = "1"
$env:ONEDRIVE_CENTER_DIR = $CenterDir
$env:ONEDRIVE_SYNC_MIN_MS = "100"

# Microsoft Graph Excel köprüsü bu modda kapalıdır; masaüstü OneDrive klasörü merkezdir.
$env:EXCEL_CENTER_ENABLED = "0"
$env:EXCEL_CENTER_PRIMARY = "0"

# Render webhook yerine yerelde polling çalışır. Bu modu kullanırken Render servisindeki
# Telegram/Moon otomasyonunu kapatmak gerekir; aynı bot token iki polling/webhook istemez.
$env:TELEGRAM_USE_POLLING = "1"
$env:BOZOK_DISABLE_TELEGRAM = "0"
$env:MOON_AUTOMATION_ENABLED = "1"
$env:MOON_AUTOMATION_INTERVAL_MS = "1000"
$env:MOON_PAGE_HEARTBEAT_MS = "5000"
$env:PORT = [string]$Port

if (!$NoExcelWatcher -and (Test-Path $WorkbookPath)) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$Root\tools\watch-excel-refresh.ps1`"",
    "-WorkbookPath", "`"$WorkbookPath`"",
    "-IntervalMs", "500"
  ) | Out-Null
}

Write-Output "Bozok Excel merkez modu basliyor..."
Write-Output "Merkez klasor: $CenterDir"
Write-Output "Panel: http://127.0.0.1:$Port/"
Write-Output "Telegram: local polling"
Write-Output "Moon bot: local playwright"
Write-Output "Render/Postgres: devre disi"

node proxy-server.js
