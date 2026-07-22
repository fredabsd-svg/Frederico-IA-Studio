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
# do web_fetch (puppeteer-core aponta para CHROMIUM_PATH; o pacote apt já traz
# as libs de que o Chromium precisa).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates postgresql-client git chromium fonts-liberation \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Caminho do Chromium do sistema para o puppeteer-core (não baixa navegador).
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev
COPY backend ./backend
WORKDIR /app/backend
EXPOSE 3001
CMD ["npm", "start"]
