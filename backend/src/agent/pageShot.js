import fs from 'fs';
import path from 'path';
import { isBlockedHost } from '../tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Miniatura de página (screenshot) com navegador headless.
//
// Usa playwright-core + o Chromium do sistema (CHROMIUM_PATH), instalado na
// imagem Docker. É BEST-EFFORT: se o pacote/binário não existir, se a página
// demorar ou falhar, retornamos false e o web_fetch segue normal (só o texto).
// Nunca lançamos erro para fora — screenshot é um extra visual, não pode
// derrubar a ferramenta de pesquisa.
//
// Segurança: o navegador executa JS da página, então cada requisição é
// interceptada e QUALQUER host interno/loopback/metadados é abortado (mesma
// regra do web_fetch, isBlockedHost) — uma página pública não pode usar o
// navegador do backend para alcançar a rede interna (SSRF).
//
// ATENÇÃO ao trocar de biblioteca: o `page.route()` do Playwright **não** é
// chamado de novo no destino de um redirecionamento — ao contrário do
// `setRequestInterception` do puppeteer, que era chamado a cada salto. Medido
// neste repositório: com um 302 de /a para /b, o puppeteer chama o guarda para
// /a **e** /b; o Playwright chama só para /a e navega para /b sem passar pelo
// guarda. Uma porta ingênua, portanto, reabriria o SSRF por redirecionamento:
// bastaria uma página pública responder 302 para 169.254.169.254. Por isso os
// redirecionamentos são seguidos AQUI, à mão (`maxRedirects: 0`), validando
// cada salto antes de continuar. Ver `pageShot.test.js`.
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTABLE = process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || '';
const ENABLED = process.env.WEB_FETCH_SCREENSHOTS !== '0';
const NAV_TIMEOUT = Math.max(3000, Number(process.env.SCREENSHOT_TIMEOUT_MS || 9000));
const IDLE_CLOSE_MS = 60_000; // fecha o navegador após 1min sem uso, para liberar RAM na VPS
const MAX_REDIRECTS = 5;

// Mídia pesada não agrega à miniatura e só atrasa o carregamento.
const HEAVY_RESOURCES = new Set(['media', 'websocket', 'eventsource']);

let browserPromise = null;   // Promise<Browser> compartilhada
let playwright = null;
let unavailable = false;      // trava: se já falhou em carregar, não tenta de novo
let idleTimer = null;

// ── Política de requisição (pura, testável sem navegador) ───────────────────

// Uma requisição do navegador só passa se for http(s), para host público e de
// um tipo que valha a pena carregar. Qualquer dúvida (URL ilegível) é NEGADA:
// aqui o padrão tem de ser fechado, não aberto.
export function allowRequest(url, resourceType = '') {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (isBlockedHost(parsed.hostname)) return false;
  if (HEAVY_RESOURCES.has(resourceType)) return false;
  return true;
}

// Próximo salto de um redirecionamento, já validado contra a mesma política.
// Devolve:
//   { done: true }            → não é redirecionamento (ou não tem Location)
//   { blocked: true }         → o destino é proibido; a requisição morre aqui
//   { url }                   → destino liberado, seguir para ele
export function nextRedirect(currentUrl, status, location, resourceType = '') {
  const code = Number(status);
  if (!(code >= 300 && code <= 399)) return { done: true };
  if (!location) return { done: true };
  let next;
  try { next = new URL(String(location), String(currentUrl)).toString(); } catch { return { blocked: true }; }
  if (!allowRequest(next, resourceType)) return { blocked: true };
  return { url: next };
}

// ── Navegador ───────────────────────────────────────────────────────────────

async function loadPlaywright() {
  if (playwright) return playwright;
  if (unavailable) return null;
  try {
    const mod = await import('playwright-core');
    playwright = mod.chromium || mod.default?.chromium || null;
    if (!playwright) unavailable = true;
    return playwright;
  } catch {
    unavailable = true; // pacote não instalado neste ambiente
    return null;
  }
}

// Exportado (junto com `getBrowser` e `guardRoute`) para o Modo Design, que
// imprime o artefato em PDF com o MESMO navegador e a MESMA guarda de rede.
// Duplicar essa infraestrutura significaria duplicar a defesa contra SSRF — e
// a cópia é justamente o lugar onde a correção do redirecionamento se perderia.
export function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { closeBrowser(); }, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function closeBrowser() {
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try { const b = await p; await b.close(); } catch {}
}

export async function getBrowser() {
  const chromium = await loadPlaywright();
  if (!chromium || !EXECUTABLE || !fs.existsSync(EXECUTABLE)) return null;
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: EXECUTABLE,
      headless: true,
      // O sandbox do Chromium não sobe como root dentro do contêiner; o
      // isolamento aqui é o do próprio contêiner (ver docs/SECURITY.md).
      chromiumSandbox: false,
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--mute-audio']
    }).catch(err => { browserPromise = null; throw err; });
  }
  try {
    const b = await browserPromise;
    // Se o navegador morreu (crash/OOM), reinicia na próxima chamada.
    if (b.isConnected && !b.isConnected()) { browserPromise = null; return getBrowser(); }
    return b;
  } catch {
    return null;
  }
}

// Guarda de rede: valida a requisição, segue os redirecionamentos à mão
// (validando cada salto) e entrega a resposta final à página.
// Exportado para teste: recebe o `route` do Playwright, mas depende só da
// interface dele (request/fetch/abort/fulfill), então um duplo de teste basta.
export async function guardRoute(route) {
  const request = route.request();
  const resourceType = request.resourceType();
  let url = request.url();

  if (!allowRequest(url, resourceType)) return route.abort();

  try {
    let response = await route.fetch({ url, maxRedirects: 0 });
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const headers = response.headers() || {};
      const step = nextRedirect(url, response.status(), headers.location, resourceType);
      if (step.blocked) return route.abort();
      if (step.done) break;
      url = step.url;
      response = await route.fetch({ url, maxRedirects: 0 });
    }
    await route.fulfill({ response });
  } catch {
    // Falha de rede/cancelamento: some com a requisição em vez de deixá-la
    // seguir sem guarda. `abort` depois da rota fechada também lança — ignore.
    try { await route.abort(); } catch {}
  }
}

// Captura uma miniatura de `url` e grava JPEG em `destPath`. Retorna true/false.
export async function captureThumbnail(url, destPath, { signal } = {}) {
  if (!ENABLED) return false;
  if (!allowRequest(url, 'document')) return false;

  const browser = await getBrowser();
  if (!browser) return false;

  let page = null;
  try {
    // No Playwright, `newPage()` abre um contexto próprio: cookies e storage
    // não vazam de uma miniatura para a seguinte.
    page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });
    await page.route('**/*', guardRoute);

    const onAbort = () => { try { page && page.close(); } catch {} };
    if (signal) {
      if (signal.aborted) { onAbort(); return false; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // Pequena folga para o layout/imagens assentarem, sem esperar rede ociosa.
    await new Promise(r => setTimeout(r, 700));

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await page.screenshot({ path: destPath, type: 'jpeg', quality: 55, fullPage: false });
    try { fs.chownSync(destPath, 1000, 1000); } catch {}
    return fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
  } catch {
    return false;
  } finally {
    try { if (page) await page.close(); } catch {}
    scheduleIdleClose();
  }
}
