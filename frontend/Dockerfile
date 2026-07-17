# Imagem de PRODUÇÃO do frontend: compila o React e serve via Caddy
# (arquivos estáticos + proxy /api -> backend + HTTPS automático do domínio).
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
