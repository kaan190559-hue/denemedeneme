#!/usr/bin/env bash
# Origin kilidi — panele sadece Cloudflare üzerinden erişim (Bozok site)
set -euo pipefail

SNIPPET="/etc/nginx/snippets/cloudflare-origin.conf"
mkdir -p /etc/nginx/snippets

echo "==> Cloudflare IP aralıkları..."
V4=$(curl -fsSL https://www.cloudflare.com/ips-v4)
V6=$(curl -fsSL https://www.cloudflare.com/ips-v6)
if [ -z "$V4" ]; then
  echo "HATA: Cloudflare IP listesi alınamadi."
  exit 1
fi

{
  echo "# Bozok — gercek ziyaretci IP (CF-Connecting-IP)"
  for ip in $V4 $V6; do echo "set_real_ip_from $ip;"; done
  echo "real_ip_header CF-Connecting-IP;"
} > "$SNIPPET"

CONF="/etc/nginx/sites-available/bozok"
if ! grep -q "cloudflare-origin.conf" "$CONF"; then
  sed -i '/^\s*server\s*{/a \    include /etc/nginx/snippets/cloudflare-origin.conf;' "$CONF"
fi

nginx -t
systemctl reload nginx

echo "==> ufw: 80/443 sadece Cloudflare..."
yes | ufw delete allow 80 >/dev/null 2>&1 || true
yes | ufw delete allow 443 >/dev/null 2>&1 || true
for ip in $V4; do
  ufw allow from "$ip" to any port 80 proto tcp >/dev/null
  ufw allow from "$ip" to any port 443 proto tcp >/dev/null
done
for ip in $V6; do
  ufw allow from "$ip" to any port 80 proto tcp >/dev/null
  ufw allow from "$ip" to any port 443 proto tcp >/dev/null
done
ufw reload >/dev/null

echo ""
echo "============================================"
echo "  Bozok origin kilidi aktif."
echo "  Erisim: sadece Cloudflare uzerinden"
echo "============================================"
