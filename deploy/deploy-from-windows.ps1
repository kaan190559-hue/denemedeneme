# Bozok — Windows'tan Hetzner kurulum
param(
    [string]$ServerIP = "178.105.211.8",
    [string]$Domain = "",
    [string]$SshKey = "$env:USERPROFILE\.ssh\vivipay",
    [string]$SshUser = "root",
    [string]$RemoteDir = "/opt/bozok",
    [string]$GitRepo = "https://github.com/kaan190559-hue/denemedeneme.git",
    [switch]$ImportFromRender,
    [switch]$SkipGitPull
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

function Invoke-Ssh([string]$Command) {
    & ssh -i $SshKey -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 "${SshUser}@${ServerIP}" $Command
    if ($LASTEXITCODE -ne 0) { throw "SSH basarisiz (exit $LASTEXITCODE)" }
}

function Invoke-Scp([string]$Local, [string]$Remote) {
    & scp -i $SshKey -o StrictHostKeyChecking=accept-new $Local "${SshUser}@${ServerIP}:${Remote}"
    if ($LASTEXITCODE -ne 0) { throw "SCP basarisiz" }
}

Write-Host ""
Write-Host "  Bozok Hetzner Kurulum" -ForegroundColor Cyan
Write-Host "  Sunucu: $ServerIP" -ForegroundColor Cyan
if ($Domain) { Write-Host "  Domain: $Domain" -ForegroundColor Cyan }
Write-Host ""

Write-Host "==> [1/6] SSH test..." -ForegroundColor Yellow
Invoke-Ssh "echo SSH_OK"

Write-Host "==> [2/6] Repo hazirlaniyor..." -ForegroundColor Yellow
if ($SkipGitPull) {
    Invoke-Ssh "mkdir -p $RemoteDir"
    $tarFile = Join-Path $env:TEMP "bozok-deploy.tar"
    if (Test-Path $tarFile) { Remove-Item $tarFile -Force }
    $exclude = @("--exclude=node_modules", "--exclude=.git", "--exclude=.env", "--exclude=.playwright-browsers",
        "--exclude=dashboard-state.json", "--exclude=change-history.json", "--exclude=telegram-daily-snapshots.json")
    & tar -cf $tarFile @exclude -C $ProjectRoot .
    Invoke-Scp $tarFile "$RemoteDir/bozok-deploy.tar"
    Invoke-Ssh "cd $RemoteDir; tar -xf bozok-deploy.tar; rm -f bozok-deploy.tar"
} else {
    $cloneCmd = @"
if [ -d '$RemoteDir/.git' ]; then
  cd '$RemoteDir' && git fetch origin && git reset --hard origin/main
else
  rm -rf '$RemoteDir'
  git clone '$GitRepo' '$RemoteDir'
fi
"@
    Invoke-Ssh $cloneCmd
}

Write-Host "==> [3/6] .env yukleniyor..." -ForegroundColor Yellow
$localEnv = Join-Path $ProjectRoot ".env"
$prodExample = Join-Path $ProjectRoot ".env.production.example"
if (Test-Path $localEnv) {
    $envContent = Get-Content $localEnv -Raw
    if ($Domain) {
        $envContent = $envContent -replace '(?m)^BOZOK_PUBLIC_URL=.*', "BOZOK_PUBLIC_URL=https://$Domain"
        if ($envContent -notmatch 'BOZOK_PUBLIC_URL=') { $envContent += "`nBOZOK_PUBLIC_URL=https://$Domain`n" }
    }
    $tempEnv = Join-Path $env:TEMP "bozok.env"
    Set-Content -Path $tempEnv -Value $envContent -NoNewline
    Invoke-Scp $tempEnv "$RemoteDir/.env"
    Remove-Item $tempEnv -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "  Yerel .env yok — sunucuda .env.production.example kullanilacak" -ForegroundColor DarkYellow
}

Write-Host "==> [4/6] Docker + Nginx kurulumu..." -ForegroundColor Yellow
Invoke-Ssh "cd $RemoteDir; sed -i 's/\r$//' deploy/*.sh deploy/nginx/*.conf 2>/dev/null; chmod +x deploy/*.sh; bash deploy/setup-server-ip.sh $ServerIP"

if ($ImportFromRender) {
    Write-Host "==> [5/6] Render verisi import..." -ForegroundColor Yellow
    Invoke-Ssh "cd $RemoteDir; bash deploy/migrate-from-render.sh; bash deploy/import-render-state.sh"
} else {
    Write-Host "==> [5/6] Render import atlandi (ImportFromRender ile acilir)" -ForegroundColor DarkYellow
}

if ($Domain) {
    Write-Host "==> [6/6] Domain + SSL: $Domain" -ForegroundColor Yellow
    Invoke-Ssh "cd $RemoteDir; bash deploy/setup-domain.sh $Domain"
} else {
    Write-Host "==> [6/6] Domain atlandi — sonra: bash deploy/setup-domain.sh bozok.domain.com" -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  BOZOK HETZNER KURULUM TAMAM" -ForegroundColor Green
if ($Domain) {
    Write-Host "  Panel: https://$Domain" -ForegroundColor White
} else {
    Write-Host "  Panel: http://${ServerIP}" -ForegroundColor White
}
Write-Host "  SSH: ssh -i $SshKey ${SshUser}@${ServerIP}" -ForegroundColor White
Write-Host ""
Write-Host "  Cloudflare sonrasi: bash deploy/cloudflare-lock.sh" -ForegroundColor DarkCyan
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
