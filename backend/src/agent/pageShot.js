import fs from 'fs';
import path from 'path';
import { isBlockedHost } from '../tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Miniatura de página (screenshot) com navegador headless.
//
// Usa puppeteer-core + o Chromium do sistema (CHROMIUM_PATH), instalado na
// imagem Docker. É BEST-EFFORT: se o pacote/binário não existir, se a página
// demorar ou falhar, retornamos null e o web_fetch segue normal (só o texto).
// Nunca lançamos erro para fora — screenshot é um extra visual, não pode
// derrubar a ferramenta de pesquisa.
//
// Segurança: o navegador executa JS da página, então cada requisição é
// interceptada e QUALQUER host interno/loopback/metadados é abortado (mesma
// regra do web_fetch, isBlockedHost) — uma página pública não pode usar o
// navegador do backend para alcançar a rede interna (SSRF).
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTABLE = process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';
const ENABLED = process.env.WEB_FETCH_SCREENSHOTS !== '0';
const NAV_TIMEOUT = Math.max(3000, Number(process.env.SCREENSHOT_TIMEOUT_MS || 9000));
const IDLE_CLOSE_MS = 60_000; // fecha o navegador após 1min sem uso, para liberar RAM na VPS

let browserPromise = null;   // Promise<Browser> compartilhada
let idleTimer = null;
let puppeteer = null;
let unavailable = false;      // trava: se já falhou em carregar, não tenta de novo

async function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  if (unavailable) return null;
  try {
    const mod = await import('puppeteer-core');
    puppeteer = mod.default || mod;
    return puppeteer;
  } catch {
    unavailable = true; // pacote não instalado neste ambiente
    return null;
  }
}

function scheduleIdleClose() {
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

async function getBrowser() {
  const pptr = await loadPuppeteer();
  if (!pptr || !EXECUTABLE || !fs.existsSync(EXECUTABLE)) return null;
  if (!browserPromise) {
    browserPromise = pptr.launch({
      executablePath: EXECUTABLE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--mute-audio']
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

// Captura uma miniatura de `url` e grava JPEG em `destPath`. Retorna true/false.
export async function captureThumbnail(url, destPath, { signal } = {}) {
  if (!ENABLED) return false;
  let target;
  try { target = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) return false;

  const browser = await getBrowser();
  if (!browser) return false;

  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 640, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', req => {
      try {
        const u = new URL(req.url());
        if (!/^https?:$/.test(u.protocol) || isBlockedHost(u.hostname)) return req.abort();
        // Mídia pesada não agrega à miniatura e atrasa o carregamento.
        if (['media', 'websocket', 'eventsource'].includes(req.resourceType())) return req.abort();
        req.continue();
      } catch { req.continue(); }
    });

    const onAbort = () => { try { page && page.close(); } catch {} };
    if (signal) {
      if (signal.aborted) { onAbort(); return false; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
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
