@echo off
cd /d "%~dp0"
start "Bozok Canli Proxy" /min node proxy-server.js
echo Bozok canli proxy baslatildi: http://127.0.0.1:8787/api/health
pause
