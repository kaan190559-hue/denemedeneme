# Bozok Financial Dashboard — Hetzner tek tık kurulum
# Çift tık veya: powershell -ExecutionPolicy Bypass -File .\KUR-HETZNER.ps1

param(
    [string]$ServerIP = "178.105.211.8",
    [string]$Domain = "",
    [switch]$ImportFromRender
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  Bozok -> Hetzner Kurulum" -ForegroundColor Cyan
Write-Host "  Sunucu: $ServerIP" -ForegroundColor Cyan
Write-Host ""

$args = @("-ServerIP", $ServerIP)
if ($Domain) { $args += @("-Domain", $Domain) }
if ($ImportFromRender) { $args += "-ImportFromRender" }

& "$ScriptDir\deploy\deploy-from-windows.ps1" @args
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Read-Host "Kapatmak icin Enter'a basin"
