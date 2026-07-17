FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
# postgresql-client fornece o pg_dump usado pela rota de backup (/api/backup)
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev
COPY backend ./backend
WORKDIR /app/backend
EXPOSE 3001
CMD ["npm", "start"]
