FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
# postgresql-client fornece o pg_dump usado pela rota de backup (/api/backup);
# git é usado pelo conector GitHub (clone/pull/push rodam no backend, para o
# token do usuário nunca entrar no sandbox)
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client git \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev
COPY backend ./backend
WORKDIR /app/backend
EXPOSE 3001
CMD ["npm", "start"]
