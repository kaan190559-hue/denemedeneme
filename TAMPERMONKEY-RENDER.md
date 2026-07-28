# Render + Tampermonkey (açık cihaz)

Sunucuda **Playwright bot kapalı** kalır (`MOON_AUTOMATION_ENABLED=0`). Moon verisi, açık oturumlu PC'den bu script ile Render Postgres'e gider.

## Eklentiler (ayrı kalır)

| Script | Ne yapar | Nerede |
|--------|----------|--------|
| **Bozok Moon Alerts v3** | Yatırım tekrar uyarısı, profil | Sadece `/deposits` |
| **Bozok Render Köprüsü** | Bakiye → Render DB | Tüm `moon.aypay.co` |

İkisini birlikte kullanabilirsin; farklı `@name`, farklı iş. Köprü scripti login yapmaz, sadece tarayıcıdaki açık oturum cookie'si ile Moon API okur.

## Kurulum

1. PC'de [Tampermonkey](https://www.tampermonkey.net/) kur.
2. Yeni script → `bozok-render-bridge.user.js` içeriğini yapıştır → kaydet.
3. Moon'a **normal giriş** yap (F12 cookie kopyalamaya gerek yok).
4. Sağ altta **Bozok köprü** rozeti görünür; ~30 sn'de bir Render'a POST atar.

### Ayarlar

- **Tek tık** rozet → Render URL ve cihaz adı
- **Çift tık** → hemen senkron

Varsayılan Render URL:

```
https://bozok-financial-dashboard.onrender.com
```

Cihaz adını anlamlı ver (ör. `Ofis-PC`, `Ecem-Laptop`). Aynı anda iki köprü çalışırsa DB son aktif cihazı tutar.

## Kontrol

Tarayıcıda:

```
https://bozok-financial-dashboard.onrender.com/api/moon-cache
```

Taze veri varsa JSON döner. Dashboard'da canlı bakiyeler güncellenir.

Telegram `/rapor` ve kasa işlemleri Render DB üzerinden devam eder; Moon bot **açma**.

## Önemli

- Moon sekmesi açık kalsın; kapalıyken senkron durur.
- Poll aralığı 30 sn (sunucu login spam'i yok).
- Dashboard artık daha seyrek API çağırır; Render tarafında bellek önbelleği ve gzip aktif (deploy sonrası).
- Eski `moon-report-userscript.js` kullanma — o hem localhost hem 1 sn poll içerir; bu köprü ondan bağımsızdır.
