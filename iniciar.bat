@echo off
setlocal
cd /d "%~dp0"
title Frederico AI Studio

echo ============================================================
echo   FREDERICO AI STUDIO
echo ============================================================
echo.

REM --- Docker precisa estar ligado ---
docker info >nul 2>&1
if errorlevel 1 (
  echo   [X] O Docker Desktop nao esta rodando.
  echo       Abra o "Docker Desktop", espere ficar VERDE e rode de novo.
  echo.
  pause
  exit /b 1
)

REM --- .env precisa existir ---
if not exist ".env" (
  echo   [X] Falta o arquivo .env nesta pasta.
  echo       Crie com sua chave antes de iniciar (notepad .env).
  echo.
  pause
  exit /b 1
)

echo Limpando execucoes anteriores (evita conflito de porta/nome)...
docker compose down --remove-orphans >nul 2>&1
docker rm -f frederico-ai-frontend frederico-ai-backend >nul 2>&1

REM --- Garante a imagem do sandbox ---
docker image inspect frederico-ai-sandbox:latest >nul 2>&1
if errorlevel 1 (
  echo Montando o sandbox pela primeira vez (pode demorar)...
  docker build -t frederico-ai-sandbox:latest ./sandbox
)

REM --- Abre o navegador sozinho depois de ~25s ---
start "" cmd /c "timeout /t 25 >nul & start http://localhost:5173"

echo.
echo Ligando o app... o navegador abre sozinho em http://localhost:5173
echo   >> Para DESLIGAR: feche esta janela ou use o parar.bat
echo.

docker compose up --build

echo.
echo App encerrado.
pause
