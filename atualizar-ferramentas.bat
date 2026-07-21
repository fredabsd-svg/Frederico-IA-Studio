@echo off
setlocal
cd /d "%~dp0"
title Frederico AI Studio - Atualizar FERRAMENTAS

echo ============================================================
echo   ATUALIZAR AS FERRAMENTAS DA IA
echo   (LibreOffice, Python e bibliotecas, OCR, ffmpeg, Node...)
echo.
echo   Reconstroi tudo DO ZERO e baixa as bases mais novas.
echo   DEMORA BASTANTE (15 a 40 min) e baixa alguns GB.
echo   Use de vez em quando (a cada 1-2 meses). No dia a dia,
echo   a atualizacao normal e o atualizar.bat.
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

echo [1/5] Baixando a versao mais recente do GitHub...
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

echo [2/5] Desligando a versao anterior...
docker compose down --remove-orphans
echo.

echo [3/5] Reconstruindo as imagens DO ZERO (atualiza LibreOffice, Python,
echo       OCR, ffmpeg e todas as demais ferramentas - pode demorar bastante)...
REM --no-cache: reinstala tudo nas versoes atuais. --pull: baixa as bases novas.
docker compose build --no-cache --pull
if errorlevel 1 (
  echo   [X] A reconstrucao falhou. Veja a mensagem de erro acima.
  echo.
  pause
  exit /b 1
)
echo.

echo [4/5] Baixando as versoes mais novas do banco (Postgres) e do Node...
REM O Postgres esta fixado na versao 16: aqui vem so correcao, nunca um salto
REM de versao que exigiria migrar o banco. Se voce usa o antivirus local
REM (profile antivirus), atualize-o com:
REM   docker compose --profile antivirus pull clamav
docker compose pull postgres frontend
echo       Limpando as imagens antigas (libera espaco em disco)...
docker image prune -f
echo.

echo [5/5] Ligando o app com as ferramentas novas...
echo   ^>^> O navegador abre sozinho em http://localhost:5173
echo   ^>^> Para DESLIGAR depois: feche esta janela ou use o parar.bat
echo.

REM --- Abre o navegador sozinho depois de ~30s ---
start "" cmd /c "timeout /t 30 >nul & start http://localhost:5173"

docker compose up

echo.
echo App encerrado.
pause
