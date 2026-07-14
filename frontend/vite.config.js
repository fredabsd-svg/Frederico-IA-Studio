import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// host: true e allowedHosts: true permitem abrir o app de outros aparelhos
// (celular/tablet na mesma rede, ou via Tailscale), não só do próprio PC.
export default defineConfig({ plugins: [react()], server: { host: true, port: 5173, allowedHosts: true } });
