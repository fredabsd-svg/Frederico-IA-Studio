@echo off
setlocal
cd /d "%~dp0"
title Frederico AI Studio - Atualizar

echo ============================================================
echo   ATUALIZAR O FREDERICO AI STUDIO
echo   (baixa a versao mais nova do GitHub e religa o app)
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
  echo       Sem ele o app nao sobe. Crie/coloque o .env e rode de novo.
  echo.
  pause
  exit /b 1
)

echo [1/4] Baixando a versao mais recente do GitHub...
git fetch origin
if errorlevel 1 (
  echo   [X] Nao consegui acessar o GitHub. Verifique sua internet.
  echo.
  pause
  exit /b 1
)
REM Vai para a branch principal e alinha EXATAMENTE com o GitHub.
REM Isso NAO apaga o seu .env, suas conversas nem seus dados (ficam de fora do git).
git checkout -f main
git reset --hard origin/main
echo.

echo [2/4] Desligando a versao anterior...
docker compose down --remove-orphans

echo.
echo [3/4] Reconstruindo com o codigo novo (a 1a vez pode demorar)...
echo   ^>^> O navegador abre sozinho em http://localhost:5173
echo   ^>^> Para DESLIGAR depois: feche esta janela ou use o parar.bat
echo.

REM --- Abre o navegador sozinho depois de ~30s ---
start "" cmd /c "timeout /t 30 >nul & start http://localhost:5173"

echo [4/4] Ligando o app...
docker compose up --build

echo.
echo App encerrado.
pause
