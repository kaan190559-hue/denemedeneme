# Render → Hetzner tam taşıma

## Mevcut durum (sunucu `178.105.211.8`)

| Servis | Klasör | Durum |
|--------|--------|--------|
| ViViPay | `/opt/vivipay` | `panel.vivipay.uk` (SSL var) |
| Bozok kasa | `/opt/bozok` | Docker çalışıyor, geçici: `:8080` |
| Moon bot | — | **Kapalı** — Tampermonkey köprüsü kullan |
| Render | — | Kapatılacak |

## Tek komut kurulum / güncelleme (Windows)

```powershell
cd "C:\Users\user\OneDrive\Desktop\ViViPay\bozok-financial-dashboard"

powershell -ExecutionPolicy Bypass -File .\KUR-HETZNER.ps1 `
  -ServerIP 178.105.211.8 `
  -Domain "bozok.vivipay.uk" `
  -ImportFromRender
```

**Ayrı Hetzner sunucu** kullanacaksan sadece `-ServerIP` değiştir.

## Cloudflare (DNS)

1. **DNS → Add record**
   - Type: `A`
   - Name: `bozok`
   - IPv4: `178.105.211.8` (veya yeni sunucu IP)
2. SSL sertifikası alınana kadar: **DNS only (gri bulut)**
3. `setup-domain.sh` bitince: **Proxied (turuncu)** + SSL **Full (strict)**
4. Sunucuda: `bash deploy/cloudflare-lock.sh`

## Taşıma sonrası kontrol listesi

- [ ] https://bozok.vivipay.uk/api/health → `databaseActive: true`
- [ ] Telegram `/rapor` cevap veriyor
- [ ] İki cihazda kasa değişikliği anında sync
- [ ] Tampermonkey **Bozok Moon Köprüsü** → URL: `https://bozok.vivipay.uk`
- [ ] Render servisi **suspend/delete**
- [ ] PC `.env`: `BOZOK_PUBLIC_URL=https://bozok.vivipay.uk`

## Tampermonkey kurulum linki

https://www.tampermonkey.net/script_installation.php#url=https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/bozok-render-bridge.user.js

Kurulumdan sonra rozete tıkla → **Render URL** alanına `https://bozok.vivipay.uk` yaz.

## Güncelleme

```bash
ssh -i ~/.ssh/vivipay root@178.105.211.8
cd /opt/bozok
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

## Sorun giderme

| Sorun | Çözüm |
|-------|--------|
| `503` domain | DNS gri bulut, `bash deploy/setup-domain.sh bozok.vivipay.uk` |
| Telegram yok | `grep BOZOK_PUBLIC /opt/bozok/.env`, `docker logs bozok-app` |
| Moon cache bayat | Moon sekmesi + Tampermonkey köprüsü açık olsun |
| Certbot fail | Cloudflare turuncu kapalı mı, A kaydı doğru IP mi |
