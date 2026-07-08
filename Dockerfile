FROM node:20-slim
WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev
COPY backend ./backend
WORKDIR /app/backend
EXPOSE 3001
CMD ["npm", "start"]
