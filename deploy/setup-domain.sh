#!/usr/bin/env bash
# Domain + HTTPS (Let's Encrypt)
# Kullanım: bash deploy/setup-domain.sh bozok.senindomain.com [email@mail.com]
#
# ÖN KOŞUL: Cloudflare DNS A kaydı -> sunucu IP (sertifika alınana kadar gri bulut / DNS only)
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-admin@${DOMAIN}}"
if [ -z "$DOMAIN" ]; then
  echo "Kullanım: bash deploy/setup-domain.sh bozok.domain.com [email]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v certbot >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq certbot python3-certbot-nginx
fi

echo "==> DNS: $DOMAIN"
getent hosts "$DOMAIN" | head -1 || true

echo "==> BOZOK_PUBLIC_URL güncelleniyor..."
if grep -q '^BOZOK_PUBLIC_URL=' .env; then
  sed -i "s|^BOZOK_PUBLIC_URL=.*|BOZOK_PUBLIC_URL=https://${DOMAIN}|" .env
else
  echo "BOZOK_PUBLIC_URL=https://${DOMAIN}" >> .env
fi

echo "==> Nginx HTTP config..."
sed "s/BOZOK_DOMAIN/${DOMAIN}/g" deploy/nginx/bozok.conf > /etc/nginx/sites-available/bozok
ln -sf /etc/nginx/sites-available/bozok /etc/nginx/sites-enabled/bozok
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t
systemctl reload nginx

echo "==> SSL (Let's Encrypt)..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo "==> Container env yenileme..."
docker compose -f docker-compose.prod.yml up -d

echo "==> Telegram webhook yenileme..."
sleep 5
curl -fsS "https://${DOMAIN}/api/health" >/dev/null || true

echo ""
echo "============================================"
echo "  HTTPS hazır: https://${DOMAIN}"
echo "  Sonraki: Cloudflare turuncu bulut +"
echo "           bash deploy/cloudflare-lock.sh"
echo "============================================"
