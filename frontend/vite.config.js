import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// host:true + allowedHosts:true => o app pode ser aberto de outros aparelhos
// (celular/tablet na rede, ou via Tailscale), não só do próprio PC.
// proxy /api => tudo fica na MESMA origem (uma porta só): o Vite repassa as
// chamadas de API para o backend. Assim HTTPS (Tailscale) funciona sem
// "conteúdo misto" e sem CORS.
const proxyApi = {
  // SSE precisa passar cru: sem buffer e sem timeout curto, senão o stream
  // do chat chega em blocos (ou morre) só no proxy — um bug que não existe
  // em produção, onde o nginx fala direto com o backend.
  '/api': {
    target: process.env.VITE_PROXY_TARGET || 'http://backend:3001',
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0
  }
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: proxyApi
  },
  // `preview` serve o BUILD. Sem o mesmo proxy, o bundle de produção servido
  // localmente não acha a API — é assim que os testes E2E (e2e/) exercitam o
  // mesmo bundle que vai para a VPS, em vez do dev server.
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
    proxy: proxyApi
  }
});
