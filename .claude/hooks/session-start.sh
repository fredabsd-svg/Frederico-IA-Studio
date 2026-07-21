#!/bin/bash
# SessionStart hook — roda automaticamente no início de cada sessão do
# Claude Code na web (container efêmero, então a config não persiste entre
# sessões: por isso ela é reaplicada aqui toda vez).
set -uo pipefail

# Só no ambiente remoto (Claude Code na web). Em máquina local o desenvolvedor
# gerencia o próprio git/dependências — saímos sem alterar nada.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# 1) CORREÇÃO DO ERRO DE CERTIFICADO AO CLONAR/PULL VIA HTTPS
#    O proxy de egresso re-termina o TLS com uma CA própria. Sem apontar o git
#    para esse pacote de CA, clones/pulls do GitHub falham com
#    "server certificate verification failed". Idempotente; só quando o bundle
#    existe (nunca desativamos a verificação de TLS).
if [ -f /root/.ccr/ca-bundle.crt ]; then
  git config --global http.sslCAInfo /root/.ccr/ca-bundle.crt
  echo "[session-start] git configurado para confiar na CA do proxy."
fi

# 2) Dependências prontas para rodar os testes. Não-fatal: se algo falhar, a
#    sessão ainda sobe (e o git já ficou configurado no passo 1). O backend usa
#    --ignore-scripts porque o postinstall do 'sharp' baixa um binário
#    bloqueado pela política de egresso (403); os testes não dependem dele.
if [ -f "$CLAUDE_PROJECT_DIR/backend/package.json" ]; then
  (cd "$CLAUDE_PROJECT_DIR/backend" && npm install --no-audit --no-fund --ignore-scripts --loglevel=error >/dev/null 2>&1) \
    && echo "[session-start] dependências do backend instaladas." \
    || echo "[session-start] AVISO: npm install do backend falhou (siga mesmo assim)."
fi
if [ -f "$CLAUDE_PROJECT_DIR/frontend/package.json" ]; then
  (cd "$CLAUDE_PROJECT_DIR/frontend" && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1) \
    && echo "[session-start] dependências do frontend instaladas." \
    || echo "[session-start] AVISO: npm install do frontend falhou (siga mesmo assim)."
fi

exit 0
