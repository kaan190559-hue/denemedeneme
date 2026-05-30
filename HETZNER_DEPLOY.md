# Bozok Hetzner/VPS Kurulum

Bu kurulumda Render yerine tek VPS üzerinde iki servis çalışır:

- `app`: panel, Telegram botu ve Moon otomasyon botu
- `db`: kalıcı PostgreSQL ortak kayıt deposu

Bu modelde ortak kayıt dosyaya değil PostgreSQL'e yazılır. Bir kullanıcı bakiye değiştirince ya da hesap silince işlem server'da uygulanır ve bütün açık panellere canlı event olarak dağıtılır.

## 1. Sunucu

Öneri:

- Ubuntu 24.04
- En az 2 GB RAM
- 1 vCPU yeterli, Playwright için 2 vCPU daha rahat olur

## 2. Docker Kur

```bash
apt update
apt install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## 3. Projeyi Çek

```bash
git clone https://github.com/kaan190559-hue/denemedeneme.git /opt/bozok
cd /opt/bozok
```

## 4. `.env` Hazırla

Mevcut Render environment değerlerini aynı isimlerle `.env` dosyasına koy:

```bash
POSTGRES_PASSWORD=uzun-rastgele-sifre
TELEGRAM_BOT_TOKEN=...
MOON_AUTOMATION_ENABLED=1
MOON_USERNAME=...
MOON_PASSWORD=...
MOON_TOTP_SECRET=...
MOON_AUTOMATION_INTERVAL_MS=1000
MOON_HEADLESS=1
```

`DATABASE_URL` yazma. Docker compose bunu içerideki Postgres'e otomatik bağlar.

## 5. Başlat

```bash
docker compose up -d --build
docker compose logs -f app
```

Panel:

```text
http://SUNUCU_IP:10000
```

Sağlık kontrolü:

```bash
curl http://127.0.0.1:10000/api/health
```

`storage.databaseActive` değeri `true` olmalı. Değilse ortak kayıt garanti değildir.

## 6. Güncelleme

```bash
cd /opt/bozok
git pull
docker compose up -d --build
```

## 7. Render'dan Geçiş

Render'daki son doğru ortak kayıt gerekiyorsa:

```bash
curl https://bozok-financial-dashboard.onrender.com/api/dashboard-state > dashboard-state-export.json
```

Sonra yeni sunucuda import endpoint'i yerine panelden veriyi bir kere kaydetmek yeterli. Gerekirse dosyayı `/opt/bozok` altında `dashboard-state.json` olarak koyup servis başlatılabilir; app ilk okuma sonrası PostgreSQL'e taşır.
