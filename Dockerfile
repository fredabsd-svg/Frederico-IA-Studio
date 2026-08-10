FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
# ca-certificates é OBRIGATÓRIO: o binário do git usa o CA store do SISTEMA para
# validar o TLS do github.com. Sem ele, `git clone https://github.com/...` falha
# com "unable to get local issuer certificate" — enquanto o fetch do Node (que
# usa o CA embutido no próprio Node) continua funcionando. Era exatamente esse
# descompasso que fazia o github_clone falhar no Modo Desenvolvedor mesmo com a
# API do GitHub respondendo. Com --no-install-recommends o git NÃO puxa o pacote
# sozinho (ele só o "Recommends"), então instalamos explicitamente.
# postgresql-client fornece o pg_dump usado pela rota de backup (/api/backup);
# git é usado pelo conector GitHub (clone/pull/push rodam no backend, para o
# token do usuário nunca entrar no sandbox);
# chromium + fontes são o navegador headless usado para a MINIATURA de página
# do web_fetch (playwright-core aponta para CHROMIUM_PATH; o pacote apt já traz
# as libs de que o Chromium precisa).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates postgresql-client git chromium fonts-liberation \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Caminho do Chromium do SISTEMA para o playwright-core. Usamos o chromium do
# apt em vez de `playwright install` de propósito: o download traria ~150 MB de
# navegador para a imagem de produção quando o apt já instalou um, com as libs
# resolvidas pelo gerenciador de pacotes. Em troca, a combinação
# playwright + chromium do Debian não é a testada oficialmente pelo projeto —
# aceitável porque a miniatura é BEST-EFFORT: se o navegador não subir, o
# web_fetch segue com o texto (ver src/agent/pageShot.js).
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev
COPY backend ./backend
# O validador de artefatos é Python que o BACKEND lê e manda para o sandbox
# executar (src/agent/outputs.js). Ele mora em sandbox/ junto com o resto do
# Python do projeto, mas precisa existir DENTRO desta imagem — sem esta linha, a
# validação dos .xlsx/.docx/.pdf gerados para de rodar. O caminho relativo
# (/app/backend/src/agent → /app/sandbox) é o mesmo do repositório, e
# `outputs.validatorSeam.test.js` cobra que ele continue resolvendo.
COPY sandbox/validar_artefato.py ./sandbox/
WORKDIR /app/backend
EXPOSE 3001
CMD ["npm", "start"]
