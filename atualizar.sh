#!/usr/bin/env bash
# Atualiza o Frederico AI Studio EM PRODUÇÃO (rode na VPS, na pasta do projeto):
#   bash atualizar.sh                 -> atualização normal (código novo do GitHub)
#   bash atualizar.sh --ferramentas   -> além do código, atualiza TODAS as
#      ferramentas que a IA usa (LibreOffice, Python e suas bibliotecas, OCR,
#      ffmpeg, Node, compiladores, Postgres, antivírus...). Reconstrói as
#      imagens DO ZERO e baixa as bases mais novas — demora bem mais
#      (15–40 min) e baixa alguns GB. Use de vez em quando (a cada 1–2 meses).
# Baixa a versão nova do GitHub, reconstrói e reinicia. NÃO apaga dados:
# o banco (Postgres), os arquivos (workspaces) e o seu .env são preservados.
set -euo pipefail
cd "$(dirname "$0")"

FERRAMENTAS=0
for arg in "$@"; do
  case "$arg" in
    --ferramentas|--tools) FERRAMENTAS=1 ;;
    *)
      echo "Opção desconhecida: $arg"
      echo "Uso: bash atualizar.sh [--ferramentas]"
      exit 1
      ;;
  esac
done

if [ "$FERRAMENTAS" = 1 ]; then TOTAL=6; else TOTAL=4; fi

echo "==> [1/$TOTAL] Sincronizando com a versão publicada (branch main)..."
# Produção SEMPRE segue a main publicada. Antes usávamos "git pull --ff-only",
# que quebra com "no tracking information" quando a VPS fica numa branch de
# feature (ou sem upstream). Agora forçamos a main, independente da branch atual.
# Só arquivos VERSIONADOS são afetados: o .env, os workspaces e os volumes do
# Postgres estão no .gitignore e são preservados (reset --hard não remove nem
# toca em arquivos não versionados).
git fetch origin main
git reset --hard            # limpa mudanças locais em arquivos versionados
git checkout -B main origin/main
git reset --hard origin/main

if [ "$FERRAMENTAS" = 1 ]; then
  echo "==> [2/$TOTAL] Reconstruindo as imagens DO ZERO — atualiza LibreOffice, Python,"
  echo "    OCR, ffmpeg e todas as demais ferramentas da IA (pode demorar 15–40 min)..."
  # --no-cache: refaz todas as camadas (reinstala apt/pip/npm nas versões atuais).
  # --pull: baixa as bases mais novas (python:3.12-slim, node:20-slim...) antes.
  docker compose -f docker-compose.prod.yml build --no-cache --pull

  echo "==> [3/$TOTAL] Baixando as versões mais novas do Postgres e do antivírus..."
  # O Postgres está fixado em pg16: o pull traz só correções da versão 16,
  # nunca um salto de versão maior (que exigiria migrar o banco).
  docker compose -f docker-compose.prod.yml pull postgres clamav

  echo "==> [4/$TOTAL] Religando os serviços com as imagens novas..."
  docker compose -f docker-compose.prod.yml up -d
else
  echo "==> [2/$TOTAL] Reconstruindo e reiniciando os serviços (os antigos seguem no ar durante o build)..."
  docker compose -f docker-compose.prod.yml up -d --build
fi

echo "==> [$((TOTAL-1))/$TOTAL] Removendo imagens antigas (libera espaço em disco)..."
docker image prune -f

echo "==> [$TOTAL/$TOTAL] Status atual dos serviços:"
docker compose -f docker-compose.prod.yml ps

echo ""
echo "✅ Pronto! Atualização concluída. Confira em https://fredericostudio.com.br"
