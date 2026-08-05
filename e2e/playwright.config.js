// Configuração dos testes ponta a ponta.
//
// O que estes testes cobrem e por que existem: até aqui o frontend só tinha
// teste de MÓDULO (modelFilters, sse, promptCoach...). Nenhum abria o app.
// O streaming — SSE ao vivo, troca de conversa no meio da resposta, reconexão —
// só se prova com navegador de verdade, e é justamente o item 1 da lista
// "para chegar ao verde" em docs/AUDITORIA_2026-07.md §6.
//
// Nada aqui fala com provedor de IA de verdade: `fixtures/provedorFalso.mjs`
// é um servidor OpenAI-compatível determinístico. Os testes são offline.
//
// Sobe três processos (webServer), todos em 127.0.0.1:
//   1. provedor falso   — o "modelo"
//   2. backend          — o app de verdade, contra o PostgreSQL de E2E
//   3. frontend         — `vite preview` do build de produção, com proxy /api
//
// O PostgreSQL NÃO sobe aqui: é pré-requisito (veja o README). Assim o mesmo
// arquivo serve para a máquina do time e para a CI, que já tem o serviço.
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORTA_PROVEDOR = Number(process.env.E2E_PORTA_PROVEDOR || 4599);
const PORTA_BACKEND = Number(process.env.E2E_PORTA_BACKEND || 3197);
const PORTA_FRONTEND = Number(process.env.E2E_PORTA_FRONTEND || 4173);

const DATABASE_URL = process.env.E2E_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://studio:studio@127.0.0.1:5432/studio';

// Diretórios descartáveis: o backend grava workspace e dados aqui.
const TEMP = path.join(raiz, 'e2e', '.tmp');

const ambienteBackend = {
  DATABASE_URL,
  // Chaves de mentira, com o formato que o backend exige. Não são segredo:
  // valem só para o banco descartável de E2E.
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secre',
  PORT: String(PORTA_BACKEND),
  WORKSPACE_ROOT: path.join(TEMP, 'ws'),
  DATA_DIR: path.join(TEMP, 'dados'),
  // Sem Docker no runner de E2E: nada de reconciliar sandbox no boot.
  SANDBOX_RECONCILE_ON_BOOT: 'false',
  // A miniatura de página abriria navegador de verdade no meio do teste.
  WEB_FETCH_SCREENSHOTS: '0',
  // O teste do provedor "travado" precisa que o watchdog encerre o stream sem
  // esperar os 180s padrão. ATENÇÃO ao piso: `streamGuard.js` aplica
  // `Math.max(30000, ...)` a esta variável, e há um teste unitário guardando
  // esse piso — pedir menos que 30s aqui não acelera nada, só engana quem lê.
  // Com o limite de recuperação em 1, o ciclo é stall (30s) → tenta de novo →
  // stall (30s) → desiste: ~60s, e é por isso que o teste do watchdog carrega
  // um timeout próprio bem maior que o do arquivo.
  STREAM_STALL_TIMEOUT_MS: '30000',
  MODEL_STREAM_RECOVERY_LIMIT: '1',
  NODE_ENV: 'test'
};

export default defineConfig({
  testDir: './tests',
  // Um worker: as conversas do app compartilham fila e teto de execuções por
  // usuário, e o banco é único. Serial troca alguns segundos por determinismo —
  // num conjunto deste tamanho, é o negócio certo.
  workers: 1,
  fullyParallel: false,
  // Streaming tem tempo real embutido; o padrão de 30s é apertado demais.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORTA_FRONTEND}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo'
  },
  projects: [
    // Só Chromium de propósito: o app é usado no navegador do escritório e a
    // conta de manutenção de três navegadores não se paga aqui.
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // E2E_CHROMIUM_PATH aponta um Chromium JÁ instalado, para ambientes que
        // trazem o próprio (contêiner de desenvolvimento) e onde baixar outro
        // seria desperdício. Vazio = o navegador do próprio Playwright,
        // que é o caminho da CI (`npm run navegador`).
        launchOptions: process.env.E2E_CHROMIUM_PATH
          ? { executablePath: process.env.E2E_CHROMIUM_PATH }
          : {}
      }
    }
  ],
  webServer: [
    {
      command: 'node fixtures/provedorFalso.mjs',
      url: `http://127.0.0.1:${PORTA_PROVEDOR}/saude`,
      cwd: path.join(raiz, 'e2e'),
      env: { E2E_PORTA_PROVEDOR: String(PORTA_PROVEDOR) },
      // Sempre subir do zero, inclusive na máquina do time: reaproveitar um
      // servidor que ficou de pé faz o teste rodar contra CÓDIGO VELHO e falhar
      // (ou passar) sem motivo aparente. Custou uma depuração; não repita.
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: 'node src/server.js',
      url: `http://127.0.0.1:${PORTA_BACKEND}/api/health`,
      cwd: path.join(raiz, 'backend'),
      env: ambienteBackend,
      // Sempre subir do zero, inclusive na máquina do time: reaproveitar um
      // servidor que ficou de pé faz o teste rodar contra CÓDIGO VELHO e falhar
      // (ou passar) sem motivo aparente. Custou uma depuração; não repita.
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe'
    },
    {
      // `preview` serve o BUILD de produção — o mesmo bundle que vai para a
      // VPS. Testar o dev server deixaria o build sem cobertura.
      command: `npm run build && npm run preview -- --port ${PORTA_FRONTEND} --strictPort`,
      url: `http://127.0.0.1:${PORTA_FRONTEND}/`,
      cwd: path.join(raiz, 'frontend'),
      env: { VITE_PROXY_TARGET: `http://127.0.0.1:${PORTA_BACKEND}` },
      // Sempre subir do zero, inclusive na máquina do time: reaproveitar um
      // servidor que ficou de pé faz o teste rodar contra CÓDIGO VELHO e falhar
      // (ou passar) sem motivo aparente. Custou uma depuração; não repita.
      reuseExistingServer: false,
      timeout: 180_000
    }
  ]
});
