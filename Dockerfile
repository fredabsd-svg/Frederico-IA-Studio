FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
# postgresql-client fornece o pg_dump usado pela rota de backup (/api/backup);
# git é usado pelo conector GitHub (clone/pull/push rodam no backend, para o
# token do usuário nunca entrar no sandbox);
# chromium + fontes são o navegador headless usado para a MINIATURA de página
# do web_fetch (puppeteer-core aponta para CHROMIUM_PATH; o pacote apt já traz
# as libs de que o Chromium precisa).
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-client git chromium fonts-liberation \
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
