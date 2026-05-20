@echo off
cd /d "%~dp0"
start "Bozok Canli Proxy" /min node proxy-server.js
start "Bozok Telegram Bot" /min node telegram-bot.js
start "" "https://raw.githack.com/kaan190559-hue/denemedeneme/main/index.html?v=shared-state"
echo Bozok canli proxy baslatildi: http://127.0.0.1:8787/api/health
echo Telegram bot ve dashboard acildi.
pause
