#!/usr/bin/env bash
# IP ile ilk kurulum (domain/SSL öncesi)
# Kullanım: bash deploy/setup-server-ip.sh [SUNUCU_IP]
set -euo pipefail

SERVER_IP="${1:-127.0.0.1}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

sed -i 's/\r$//' .env .env.production.example deploy/*.sh deploy/nginx/*.conf 2>/dev/null || true
chmod +x deploy/*.sh 2>/dev/null || true

echo "==> Sistem paketleri..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates nginx ufw docker-compose-plugin 2>/dev/null || true
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Firewall (SSH + HTTP)..."
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

echo "==> .env kontrolü..."
if [ ! -f .env ]; then
  cp .env.production.example .env
  PW="$(openssl rand -hex 24)"
  sed -i "s|DEGISTIR_uzun_rastgele_sifre|${PW}|g" .env
  echo "UYARI: .env oluşturuldu — TELEGRAM ve MOON değerlerini düzenleyin: nano .env"
fi

if ! grep -q '^BOZOK_PUBLIC_URL=https://' .env 2>/dev/null; then
  if [ "$SERVER_IP" != "127.0.0.1" ]; then
    sed -i "s|^BOZOK_PUBLIC_URL=.*|BOZOK_PUBLIC_URL=http://${SERVER_IP}|" .env || echo "BOZOK_PUBLIC_URL=http://${SERVER_IP}" >> .env
  fi
fi

echo "==> Bozok container'ları..."
docker compose -f docker-compose.prod.yml up -d --build

echo "==> DB sağlık bekleniyor..."
for i in $(seq 1 60); do
  s=$(docker inspect -f '{{.State.Health.Status}}' bozok-db 2>/dev/null || echo none)
  echo "  db=$s"
  [ "$s" = "healthy" ] && break
  sleep 2
done

echo "==> App sağlık bekleniyor..."
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:10000/api/health >/dev/null 2>&1; then
    echo "  app=healthy"
    break
  fi
  sleep 3
done

echo "==> Nginx (HTTP)..."
sed "s/BOZOK_DOMAIN/${SERVER_IP}/g" deploy/nginx/bozok.conf > /etc/nginx/sites-available/bozok
ln -sf /etc/nginx/sites-available/bozok /etc/nginx/sites-enabled/bozok
nginx -t
systemctl reload nginx

echo "==> Yedek cron..."
mkdir -p backups
CRON_LINE="0 4 * * * ${ROOT_DIR}/deploy/backup.sh >> ${ROOT_DIR}/backups/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -Fv "bozok/deploy/backup.sh"; echo "$CRON_LINE" ) | crontab -

echo ""
echo "============================================"
echo "  Bozok Hetzner hazır (HTTP)"
echo "  Panel: http://${SERVER_IP}"
echo "  Health: curl http://127.0.0.1:10000/api/health"
echo "  Domain: bash deploy/setup-domain.sh bozok.domain.com"
echo "============================================"
