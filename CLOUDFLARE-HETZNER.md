# Bozok — Hetzner + Cloudflare kurulum rehberi

Render yerine ViViPay ile aynı Hetzner sunucusunda (`178.105.211.8`) veya ayrı VPS'te çalıştırma.

## Hızlı kurulum (Windows)

```powershell
cd "C:\Users\user\OneDrive\Desktop\ViViPay\bozok-financial-dashboard"

# 1) Sadece sunucu (IP ile)
powershell -ExecutionPolicy Bypass -File .\KUR-HETZNER.ps1

# 2) Render verisi + domain ile
powershell -ExecutionPolicy Bypass -File .\KUR-HETZNER.ps1 -Domain "bozok.senindomain.com" -ImportFromRender
```

Önce deploy dosyalarını GitHub'a push et (sunucu `git pull` ile alır).

---

## Adım 1 — Cloudflare'den domain

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Register Domains** veya mevcut domain ekle
2. **DNS** → **Add record**
   - Type: `A`
   - Name: `bozok` (tam adres: `bozok.senindomain.com`)
   - IPv4: `178.105.211.8`
   - Proxy: **DNS only (gri bulut)** — SSL alınana kadar
3. ViViPay için ayrı kayıt: `panel` → aynı IP (zaten varsa dokunma)

---

## Adım 2 — Hetzner kurulum

SSH anahtarı ViViPay ile aynı: `%USERPROFILE%\.ssh\vivipay`

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy-from-windows.ps1 `
  -ServerIP 178.105.211.8 `
  -Domain bozok.senindomain.com `
  -ImportFromRender
```

Ne yapar:
- `/opt/bozok` — git clone
- Yerel `.env` → sunucuya (Telegram, Moon tokenları)
- Docker: `bozok-db` + `bozok-app` (port 10000, sadece localhost)
- Nginx reverse proxy
- Let's Encrypt SSL
- Render'dan dashboard state import (opsiyonel)

---

## Adım 3 — Cloudflare proxy + kilit

SSL çalıştıktan sonra:

1. Cloudflare DNS → `bozok` kaydında **turuncu bulut** (Proxied) aç
2. SSL/TLS → **Full (strict)**
3. Sunucuda origin kilidi:

```bash
ssh -i ~/.ssh/vivipay root@178.105.211.8
cd /opt/bozok
bash deploy/cloudflare-lock.sh
```

---

## Adım 4 — Render'ı kapat

1. Render dashboard → bozok servisi → suspend/delete
2. Telegram artık Hetzner webhook kullanır (`BOZOK_PUBLIC_URL`)
3. PC `.env`: `DASHBOARD_STATE_URL=https://bozok.senindomain.com`

---

## Güncelleme

```bash
cd /opt/bozok
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

---

## Sağlık kontrolü

```bash
curl -s http://127.0.0.1:10000/api/health | head
curl -s https://bozok.senindomain.com/api/health | head
```

`storage.databaseActive: true` olmalı.

---

## ViViPay ile aynı sunucu

| Servis | Klasör | Port (internal) | Nginx |
|--------|--------|-----------------|-------|
| ViViPay | `/opt/vivipay` | 8000 | `panel.domain.com` |
| Bozok | `/opt/bozok` | 10000 | `bozok.domain.com` |

Ayrı Postgres container — veritabanları karışmaz.

---

## Sorun giderme

| Sorun | Çözüm |
|-------|--------|
| SSH timeout | Hetzner firewall, sunucu açık mı |
| Certbot fail | DNS gri bulut, A kaydı doğru mu |
| Panel boş | `-ImportFromRender` veya `bash deploy/import-render-state.sh` |
| Telegram cevap yok | `BOZOK_PUBLIC_URL` HTTPS, webhook log: `docker logs bozok-app` |
