#!/usr/bin/env bash
# Atualiza o Frederico AI Studio EM PRODUÇÃO (rode na VPS, na pasta do projeto):
#   bash atualizar.sh
# Baixa a versão nova do GitHub, reconstrói e reinicia. NÃO apaga dados:
# o banco (Postgres), os arquivos (workspaces) e o seu .env são preservados.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> [1/4] Baixando a versão nova do GitHub..."
git pull --ff-only

echo "==> [2/4] Reconstruindo e reiniciando os serviços (os antigos seguem no ar durante o build)..."
docker compose -f docker-compose.prod.yml up -d --build

echo "==> [3/4] Removendo imagens antigas (libera espaço em disco)..."
docker image prune -f

echo "==> [4/4] Status atual dos serviços:"
docker compose -f docker-compose.prod.yml ps

echo ""
echo "✅ Pronto! Atualização concluída. Confira em https://fredericostudio.com.br"
