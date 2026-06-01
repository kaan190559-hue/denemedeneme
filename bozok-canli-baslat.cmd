@echo off
cd /d "%~dp0"
start "" "http://127.0.0.1:8787/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-excel-primary.ps1"
pause
