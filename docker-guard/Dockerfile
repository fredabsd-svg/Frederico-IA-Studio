# Guarda do Docker: o ÚNICO container que enxerga /var/run/docker.sock.
# Sem dependências npm de propósito — o processo que carrega o privilégio tem a
# menor superfície possível (só http/net do Node).
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY docker-guard/package.json ./
COPY docker-guard/src ./src
EXPOSE 2375
CMD ["node", "src/server.js"]
