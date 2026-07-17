@echo off
setlocal
cd /d "%~dp0"
title Frederico AI Studio - Parar

echo Desligando o Frederico AI Studio...
docker compose down --remove-orphans
docker rm -f frederico-ai-frontend frederico-ai-backend >nul 2>&1
echo.
echo Pronto. App desligado e containers limpos.
echo.
pause
