// Validação do servidor de desenvolvimento, DENTRO do sandbox (Fase 38, 2ª parte).
//
// A primeira parte (pageCheck.js) valida uma página servida do workspace pelo
// navegador do BACKEND. Ficou de fora o caso mais comum do Modo Desenvolvedor:
// o agente sobe `npm run dev` e quer conferir a aplicação rodando.
//
// A limitação parecia estrutural — o container da conversa nasce com
// `NetworkDisabled` e sem publicação de portas, então o backend não alcança o
// servidor da tarefa. A saída NÃO é abrir essa fronteira: é inverter o
// movimento. **O navegador vai até o servidor.** A imagem do sandbox já traz
// `chromium` e `playwright` (sandbox/Dockerfile), e um container sem rede
// continua tendo loopback — de dentro dele, `http://127.0.0.1:<porta>` é
// exatamente o servidor que o agente acabou de subir.
//
// Resultado: nenhuma fronteira muda. O isolamento continua sendo o do próprio
// container, e a página validada nem sequer tem rede para onde vazar.
//
// O VEREDITO é o mesmo objeto da primeira parte (`buildVerdict`): as duas
// formas de validar precisam reprovar e aprovar pelos mesmos critérios, senão
// o agente aprende que "validar de um jeito passa e do outro não".
import fs from 'fs';
import path from 'path';
import { buildVerdict } from './pageCheck.js';

// O script imprime UMA linha com este prefixo. Sem sentinela, a saída do
// navegador (avisos do Chromium, ruído do dev server) se misturaria ao
// resultado — e um parser que aceita "o último JSON que achar" transforma
// qualquer linha parecida em veredito.
export const SENTINEL = '__FREDERICO_PAGECHECK__';
const SCRIPT_DIR = '.pagecheck';
const SCRIPT_NAME = 'check.cjs';
const MAX_ITEMS = 20;

export function sandboxUrlFor(porta, rota = '/') {
  const caminho = String(rota || '/').trim() || '/';
  return `http://127.0.0.1:${Number(porta)}${caminho.startsWith('/') ? caminho : `/${caminho}`}`;
}

// Porta plausível para um servidor de desenvolvimento. Recusar aqui evita
// montar um comando com lixo e esperar o timeout para descobrir.
export function validatePort(value) {
  const porta = Number(value);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
    return { error: `Porta inválida: ${value}. Informe a porta em que o seu servidor está escutando dentro do sandbox (ex.: 5173, 8000).` };
  }
  return { porta };
}

// O SCRIPT que roda dentro do container. CommonJS de propósito: o `playwright`
// está instalado GLOBAL na imagem, e `NODE_PATH` (que o comando define) é
// honrado pelo `require`, não pelo `import` de ESM.
//
// Ele nunca lança para fora: qualquer falha vira campo no JSON. Um script que
// morre com stack trace produziria saída sem sentinela, e o chamador não
// saberia distinguir "quebrou" de "não rodou".
export function buildSandboxCheckScript({
  url,
  esperarSeletor = null,
  esperarTexto = null,
  screenshotPath = null,
  viewport = { width: 1280, height: 800 },
  timeoutMs = 15000
} = {}) {
  const cfg = JSON.stringify({
    url: String(url),
    esperarSeletor: esperarSeletor ? String(esperarSeletor) : null,
    esperarTexto: esperarTexto ? String(esperarTexto) : null,
    screenshotPath: screenshotPath ? String(screenshotPath) : null,
    viewport,
    timeoutMs,
    maxItems: MAX_ITEMS
  });
  return `// gerado por agent/pageCheckSandbox.js — apagado ao fim da validação
const CFG = ${cfg};
const SENTINEL = ${JSON.stringify(SENTINEL)};
const out = {
  status: null, title: '', visibleTextLength: 0, visualElements: 0, elementCount: 0,
  consoleErrors: [], pageErrors: [], badResponses: [], blockedRequests: [], failedRequests: [],
  navigationError: null, assercoes: [], captura: null, erroFatal: null
};
const push = (arr, v) => { if (arr.length < CFG.maxItems) arr.push(v); };
const origem = new URL(CFG.url).origin;
const mesmaOrigem = u => { try { return new URL(u).origin === origem; } catch { return false; } };

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { out.erroFatal = 'O pacote playwright não está disponível neste sandbox: ' + (e && e.message); return; }

  let browser = null, page = null;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      chromiumSandbox: false,
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--mute-audio']
    });
  } catch (e) { out.erroFatal = 'Não foi possível iniciar o navegador no sandbox: ' + (e && e.message); return; }

  try {
    page = await browser.newPage({ viewport: CFG.viewport });
    // Mesma política da validação no backend: só a origem do servidor da
    // tarefa passa; todo o resto é abortado e vira evidência.
    await page.route('**/*', route => {
      const u = route.request().url();
      if (mesmaOrigem(u)) return route.continue();
      push(out.blockedRequests, u);
      return route.abort();
    });
    page.on('console', m => { if (m.type() === 'error') push(out.consoleErrors, m.text()); });
    page.on('pageerror', e => push(out.pageErrors, (e && e.message) || String(e)));
    page.on('requestfailed', r => {
      if (!mesmaOrigem(r.url())) return;
      push(out.failedRequests, { url: r.url(), reason: (r.failure() && r.failure().errorText) || '' });
    });
    page.on('response', r => {
      if (!mesmaOrigem(r.url())) return;
      if (r.status() >= 400 && r.url() !== CFG.url) push(out.badResponses, { url: r.url(), status: r.status() });
    });

    try {
      const res = await page.goto(CFG.url, { waitUntil: 'domcontentloaded', timeout: CFG.timeoutMs });
      out.status = res ? res.status() : null;
      await page.waitForTimeout(800);
    } catch (e) { out.navigationError = (e && e.message) || String(e); }

    if (!out.navigationError) {
      try {
        const medida = await page.evaluate(() => {
          const texto = document.body ? (document.body.innerText || '').trim() : '';
          return {
            title: document.title || '',
            visibleTextLength: texto.length,
            visualElements: document.querySelectorAll('img, svg, canvas, video').length,
            elementCount: document.querySelectorAll('*').length
          };
        });
        Object.assign(out, medida);
      } catch (e) { /* a medida é extra */ }
    }

    if (CFG.esperarSeletor) {
      let n = 0;
      try { n = await page.locator(CFG.esperarSeletor).count(); } catch (e) { n = 0; }
      out.assercoes.push({
        tipo: 'seletor', valor: CFG.esperarSeletor, encontrados: n, ok: n > 0,
        descricao: 'o seletor "' + CFG.esperarSeletor + '" existe na página',
        detalhe: n > 0 ? null : 'O seletor "' + CFG.esperarSeletor + '" não existe na página renderizada.'
      });
    }
    if (CFG.esperarTexto) {
      let presente = false;
      try {
        presente = await page.evaluate(
          alvo => (document.body && document.body.innerText || '').includes(alvo), CFG.esperarTexto
        );
      } catch (e) { presente = false; }
      out.assercoes.push({
        tipo: 'texto', valor: CFG.esperarTexto, ok: presente,
        descricao: 'o texto "' + CFG.esperarTexto + '" aparece na página',
        detalhe: presente ? null : 'O texto "' + CFG.esperarTexto + '" não aparece na página renderizada.'
      });
    }

    if (CFG.screenshotPath) {
      try {
        await page.screenshot({ path: CFG.screenshotPath, type: 'jpeg', quality: 70, fullPage: false });
        out.captura = CFG.screenshotPath;
      } catch (e) { /* captura é evidência extra, nunca o veredito */ }
    }
  } catch (e) {
    out.erroFatal = (e && e.message) || String(e);
  } finally {
    try { if (page) await page.close(); } catch (e) {}
    try { if (browser) await browser.close(); } catch (e) {}
  }
})().catch(e => { out.erroFatal = (e && e.message) || String(e); })
  .finally(() => { process.stdout.write('\\n' + SENTINEL + JSON.stringify(out) + '\\n'); });
`;
}

// Lê a saída do container e extrai o resultado. PURO — é aqui que se decide o
// que fazer com saída suja, truncada ou ausente, e nenhum desses casos pode
// virar "validado".
export function parseSandboxCheckOutput(stdout) {
  const linhas = String(stdout || '').split('\n');
  // Da última para a primeira: o dev server pode continuar imprimindo log
  // depois que o navegador termina.
  for (let i = linhas.length - 1; i >= 0; i--) {
    const idx = linhas[i].indexOf(SENTINEL);
    if (idx === -1) continue;
    try {
      return { evidence: JSON.parse(linhas[i].slice(idx + SENTINEL.length)) };
    } catch {
      return { error: 'A validação rodou no sandbox mas devolveu um resultado ilegível (saída truncada?).' };
    }
  }
  return { error: 'A validação não produziu resultado no sandbox — o navegador pode não ter iniciado.' };
}

// Executa a validação dentro do container. `execSandbox` é injetado (é o
// `execInSandbox` do sandbox.js) para o módulo continuar testável sem Docker.
export async function checkSandboxPage(execSandbox, {
  workspaceBase,
  conversationId,
  sandboxOptions = {},
  porta,
  rota = '/',
  esperarSeletor = null,
  esperarTexto = null,
  screenshotName = null,
  viewport = { width: 1280, height: 800 },
  timeoutMs = 15000,
  signal
} = {}) {
  const alvo = validatePort(porta);
  if (alvo.error) return { disponivel: true, erro: alvo.error };

  const url = sandboxUrlFor(alvo.porta, rota);
  const dir = path.join(workspaceBase, SCRIPT_DIR);
  const scriptHost = path.join(dir, SCRIPT_NAME);
  const scriptSandbox = `/workspace/${SCRIPT_DIR}/${SCRIPT_NAME}`;
  const capturaSandbox = screenshotName ? `/workspace/outputs/${screenshotName}` : null;
  const capturaHost = screenshotName ? path.join(workspaceBase, 'outputs', screenshotName) : null;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(workspaceBase, 'outputs'), { recursive: true });
    fs.writeFileSync(scriptHost, buildSandboxCheckScript({
      url, esperarSeletor, esperarTexto, screenshotPath: capturaSandbox, viewport, timeoutMs
    }), 'utf8');
    try { fs.chownSync(scriptHost, 1000, 1000); } catch { /* uid do sandbox */ }
  } catch (err) {
    return { disponivel: true, erro: `Não foi possível preparar a validação: ${err?.message || err}` };
  }

  try {
    // `NODE_PATH` aponta para os pacotes globais da imagem — é o que faz o
    // `require('playwright')` resolver de dentro de um script solto.
    const cmd = `cd /workspace && NODE_PATH="$(npm root -g)" node ${scriptSandbox} 2>&1`;
    const exec = await execSandbox(conversationId, cmd, timeoutMs + 20_000, { ...sandboxOptions, signal });
    const parsed = parseSandboxCheckOutput(exec?.output || '');
    if (parsed.error) {
      return {
        disponivel: true,
        erro: parsed.error,
        saida: String(exec?.output || '').slice(-1200)
      };
    }
    const evidence = parsed.evidence;
    if (evidence.erroFatal) {
      return {
        disponivel: false,
        observacao: `A validação visual NÃO foi feita: ${evidence.erroFatal}. Não afirme que a página foi validada.`
      };
    }
    return {
      disponivel: true,
      url,
      titulo: evidence.title || '',
      status: evidence.status,
      captura: capturaHost && fs.existsSync(capturaHost) ? path.posix.join('outputs', screenshotName) : null,
      medido: {
        texto_visivel: evidence.visibleTextLength,
        elementos_visuais: evidence.visualElements,
        elementos: evidence.elementCount
      },
      ...buildVerdict(evidence, evidence.assercoes || [])
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* script temporário */ }
  }
}
