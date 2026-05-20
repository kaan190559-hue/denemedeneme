@echo off
cd /d "%~dp0"
start "Bozok Canli Proxy" /min node proxy-server.js
start "Bozok Telegram Bot" /min node telegram-bot.js
start "" "http://127.0.0.1:8787/"
echo Bozok canli proxy baslatildi: http://127.0.0.1:8787/api/health
echo Telegram bot ve dashboard acildi.
pause
