$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$CenterDir = "C:\Users\user\OneDrive\BozokMerkez"
$WorkbookPath = Join-Path $CenterDir "BozokMerkez.xlsx"

if (!(Test-Path $CenterDir)) {
  New-Item -ItemType Directory -Force -Path $CenterDir | Out-Null
}

function Test-Bridge {
  try {
    $status = Invoke-RestMethod -Uri "http://localhost:8787/api/onedrive-status" -TimeoutSec 1
    return [bool]$status.success
  } catch {
    return $false
  }
}

if (!(Test-Bridge)) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$Root\tools\run-local-proxy.ps1`""
  ) | Out-Null
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 700
    if (Test-Bridge) { break }
  }
}

Start-Process powershell -WindowStyle Hidden -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$Root\tools\watch-excel-refresh.ps1`"",
  "-WorkbookPath", "`"$WorkbookPath`"",
  "-IntervalMs", "1000"
) | Out-Null

$bridgeStatus = if (Test-Bridge) { "calisiyor" } else { "baslatilamadi" }
Write-Output "Bozok yerel kopru: $bridgeStatus"
Write-Output "OneDrive merkez: $CenterDir"
Write-Output "Excel watcher: calisiyor"
