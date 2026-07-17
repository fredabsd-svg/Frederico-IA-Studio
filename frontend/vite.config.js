import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// host:true + allowedHosts:true => o app pode ser aberto de outros aparelhos
// (celular/tablet na rede, ou via Tailscale), não só do próprio PC.
// proxy /api => tudo fica na MESMA origem (uma porta só): o Vite repassa as
// chamadas de API para o backend. Assim HTTPS (Tailscale) funciona sem
// "conteúdo misto" e sem CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': { target: process.env.VITE_PROXY_TARGET || 'http://backend:3001', changeOrigin: true }
    }
  }
});
