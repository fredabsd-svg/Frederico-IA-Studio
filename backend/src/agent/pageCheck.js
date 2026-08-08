// Validação por navegador dentro do produto (Fase 38).
//
// O PROBLEMA. O agente constrói uma página e declara "pronto, está funcionando".
// Nada mede isso. O modo de falha clássico do frontend não aparece em teste
// unitário nem no diff: um import errado, e a página abre EM BRANCO com um erro
// no console. O review gate (Fase 28) mede o diff; aqui medimos o resultado
// renderizado.
//
// COMO. A página é servida por um servidor efêmero em 127.0.0.1
// (`pagePreviewServer.js`) e aberta no Chromium do backend — o mesmo de
// `pageShot.js`, com uma guarda de rede DIFERENTE e mais estreita:
//
//   * a miniatura do web_fetch abre a internet pública e bloqueia a rede
//     interna;
//   * a validação faz o oposto e mais: só a origem fixada do servidor de
//     pré-visualização passa. **Todo o resto é abortado** — internet, loopback
//     em outra porta (inclusive a API do próprio backend), qualquer coisa.
//     O navegador da validação é OFFLINE.
//
// Isso não é só contenção: é o que torna o resultado útil. Requisição externa
// abortada vira EVIDÊNCIA ("sua página depende de 2 recursos que não
// carregaram"), em vez de sumir em silêncio.
//
// O veredito é MEDIDO, nunca opinião do modelo — mesma regra do review gate.
// E, como a miniatura e o PDF do Modo Design, é best-effort: sem Chromium no
// ambiente, devolvemos `disponivel: false` com o motivo, jamais um "validado"
// falso.
import fs from 'fs';
import path from 'path';
import { getBrowser, scheduleIdleClose } from './pageShot.js';
import { startPreviewServer } from './pagePreviewServer.js';

const NAV_TIMEOUT = Math.max(3000, Number(process.env.PAGE_CHECK_TIMEOUT_MS || 15_000));
const SETTLE_MS = 800;              // folga para o JS pintar, sem esperar rede ociosa
const MAX_ITEMS = 20;               // teto por lista de evidência
const MAX_TEXT = 300;               // teto por mensagem

function trim(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

// ── Política de requisição da validação (pura) ──────────────────────────────

// Só a origem do servidor de pré-visualização passa. Sem exceção: nem outra
// porta do loopback, nem `about:`, nem `data:` de topo.
export function allowPreviewRequest(url, origin) {
  const base = String(origin || '');
  if (!base) return false;
  let parsed;
  try { parsed = new URL(String(url)); } catch { return false; }
  return parsed.origin === base;
}

// Caminho relativo do workspace → URL no servidor. Cada segmento é codificado
// (nome com espaço ou acento é comum em arquivo gerado).
export function previewUrlFor(origin, relPath) {
  const rel = String(relPath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  return `${origin}/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}

// Caminho aceitável para validação: relativo, dentro do workspace, e uma página.
// Recusa (não normaliza) caminho absoluto e `..`, como o resto do projeto.
export function validatePagePath(relPath) {
  const rel = String(relPath || '').replaceAll('\\', '/').trim();
  if (!rel) return { error: 'Informe o caminho da página (ex.: "repo/site/dist/index.html").' };
  if (rel.startsWith('/') || /^[A-Za-z]:\//.test(rel)) return { error: `Use um caminho relativo ao workspace, não absoluto: ${rel}` };
  if (rel.split('/').includes('..')) return { error: `Caminho com ".." não é aceito: ${rel}` };
  if (!/\.x?html?$/i.test(rel)) return { error: `A validação abre uma página HTML; este caminho não parece uma: ${rel}` };
  return { path: rel };
}

// ── Veredito (puro) ─────────────────────────────────────────────────────────
//
// A separação entre PROBLEMA e AVISO é a decisão de produto deste módulo:
//
//   problema = a página está quebrada, e a evidência disso está no navegador
//              (erro não tratado, erro de console, recurso local faltando,
//              tela em branco, asserção do próprio agente que não se cumpriu);
//   aviso    = algo que a validação não consegue afirmar. Recurso EXTERNO
//              bloqueado é o caso típico: a página pode funcionar em produção
//              com a CDN no ar. Chamar isso de falha ensinaria o agente a
//              ignorar o veredito — que é o pior desfecho possível para um
//              sinal de confiança.
export function buildVerdict(evidence = {}, assertions = []) {
  const problemas = [];
  const avisos = [];

  if (evidence.navigationError) {
    problemas.push(`A página não carregou: ${trim(evidence.navigationError)}`);
  }
  const status = Number(evidence.status);
  if (status >= 400) problemas.push(`O servidor respondeu ${status} para a própria página.`);

  for (const err of (evidence.pageErrors || []).slice(0, MAX_ITEMS)) {
    problemas.push(`Erro de JavaScript não tratado: ${trim(err)}`);
  }
  for (const msg of (evidence.consoleErrors || []).slice(0, MAX_ITEMS)) {
    problemas.push(`Erro no console: ${trim(msg)}`);
  }
  for (const item of (evidence.badResponses || []).slice(0, MAX_ITEMS)) {
    problemas.push(`Recurso da própria página não encontrado (${item.status}): ${trim(item.url)}`);
  }

  // Tela em branco: sem texto visível E sem nenhum elemento visual. As duas
  // condições juntas, porque uma página só de imagem ou só de canvas é
  // legítima e não pode ser reprovada por não ter texto.
  if (evidence.navigationError == null && !(evidence.visibleTextLength > 0) && !(evidence.visualElements > 0)) {
    problemas.push('A página abriu EM BRANCO: nenhum texto visível e nenhum elemento visual (imagem, svg, canvas ou vídeo).');
  }

  for (const item of (evidence.blockedRequests || []).slice(0, MAX_ITEMS)) {
    avisos.push(`Recurso externo não carregado (a validação roda offline, de propósito): ${trim(item)}`);
  }
  for (const item of (evidence.failedRequests || []).slice(0, MAX_ITEMS)) {
    avisos.push(`Requisição falhou: ${trim(item.url)}${item.reason ? ` (${trim(item.reason)})` : ''}`);
  }

  const assercoes = (assertions || []).map(a => ({ ...a }));
  for (const a of assercoes) {
    if (a.ok === false) problemas.push(a.detalhe || `Asserção não cumprida: ${trim(a.descricao)}`);
  }

  return {
    ok: problemas.length === 0,
    problemas,
    avisos,
    assercoes,
    // Frase única para o modelo tratar como fato, não como sugestão.
    resumo: problemas.length === 0
      ? `A página carregou sem erro${avisos.length ? `, com ${avisos.length} aviso(s)` : ''}.`
      : `A página tem ${problemas.length} problema(s) medido(s) no navegador — corrija antes de dizer que está pronta.`
  };
}

// ── Execução com navegador (best-effort) ────────────────────────────────────

// Mede o que renderizou. Roda DENTRO da página, então precisa ser autocontido.
const MEASURE = `(() => {
  const body = document.body;
  const texto = body ? (body.innerText || '').trim() : '';
  const visuais = document.querySelectorAll('img, svg, canvas, video').length;
  return {
    title: document.title || '',
    visibleTextLength: texto.length,
    visualElements: visuais,
    elementCount: document.querySelectorAll('*').length
  };
})()`;

export async function checkPage(root, relPath, {
  esperarSeletor = null,
  esperarTexto = null,
  screenshotPath = null,
  viewport = { width: 1280, height: 800 },
  signal
} = {}) {
  const alvo = validatePagePath(relPath);
  if (alvo.error) return { disponivel: true, erro: alvo.error };

  const arquivo = path.join(root, alvo.path);
  if (!fs.existsSync(arquivo)) {
    return { disponivel: true, erro: `A página não existe no workspace: ${alvo.path}` };
  }

  const browser = await getBrowser();
  if (!browser) {
    return {
      disponivel: false,
      observacao: 'Não há navegador headless neste ambiente (Chromium ausente), então a validação visual NÃO foi feita. Não afirme que a página foi validada — diga que a checagem não pôde rodar aqui.'
    };
  }

  let server = null;
  let page = null;
  const evidence = {
    status: null, title: '', visibleTextLength: 0, visualElements: 0, elementCount: 0,
    consoleErrors: [], pageErrors: [], badResponses: [], blockedRequests: [], failedRequests: [],
    navigationError: null
  };
  const push = (arr, value) => { if (arr.length < MAX_ITEMS) arr.push(value); };

  try {
    server = await startPreviewServer(root);
    const origin = server.origin;
    const url = previewUrlFor(origin, alvo.path);

    page = await browser.newPage({ viewport });
    await page.route('**/*', route => {
      const alvoUrl = route.request().url();
      if (allowPreviewRequest(alvoUrl, origin)) return route.continue();
      push(evidence.blockedRequests, alvoUrl);
      return route.abort();
    });
    page.on('console', msg => { if (msg.type() === 'error') push(evidence.consoleErrors, msg.text()); });
    page.on('pageerror', err => push(evidence.pageErrors, err?.message || String(err)));
    page.on('requestfailed', req => {
      const url_ = req.url();
      // Requisição externa já foi contada como bloqueada — não conte duas vezes.
      if (!allowPreviewRequest(url_, origin)) return;
      push(evidence.failedRequests, { url: url_, reason: req.failure()?.errorText || '' });
    });
    page.on('response', res => {
      if (!allowPreviewRequest(res.url(), origin)) return;
      if (res.status() >= 400 && res.url() !== url) push(evidence.badResponses, { url: res.url(), status: res.status() });
    });

    const onAbort = () => { try { page && page.close(); } catch {} };
    if (signal) {
      if (signal.aborted) { onAbort(); return { disponivel: true, erro: 'Validação cancelada.' }; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      evidence.status = response ? response.status() : null;
      await page.waitForTimeout(SETTLE_MS);
    } catch (err) {
      evidence.navigationError = err?.message || String(err);
    }

    if (!evidence.navigationError) {
      try { Object.assign(evidence, await page.evaluate(MEASURE)); } catch { /* medida é extra */ }
    }

    const assercoes = [];
    if (esperarSeletor) {
      let encontrados = 0;
      try { encontrados = await page.locator(String(esperarSeletor)).count(); } catch { encontrados = 0; }
      assercoes.push({
        tipo: 'seletor', valor: String(esperarSeletor), encontrados, ok: encontrados > 0,
        descricao: `o seletor "${esperarSeletor}" existe na página`,
        detalhe: encontrados > 0 ? null : `O seletor "${trim(esperarSeletor)}" não existe na página renderizada.`
      });
    }
    if (esperarTexto) {
      const procurado = String(esperarTexto);
      let presente = false;
      try {
        presente = await page.evaluate(
          alvoTexto => (document.body?.innerText || '').includes(alvoTexto),
          procurado
        );
      } catch { presente = false; }
      assercoes.push({
        tipo: 'texto', valor: procurado, ok: presente,
        descricao: `o texto "${procurado}" aparece na página`,
        detalhe: presente ? null : `O texto "${trim(procurado)}" não aparece na página renderizada.`
      });
    }

    let captura = null;
    if (screenshotPath) {
      try {
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 70, fullPage: false });
        try { fs.chownSync(screenshotPath, 1000, 1000); } catch {}
        if (fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0) {
          captura = path.relative(root, screenshotPath);
        }
      } catch { /* a captura é evidência extra, nunca o veredito */ }
    }

    return {
      disponivel: true,
      pagina: alvo.path,
      titulo: evidence.title,
      status: evidence.status,
      captura,
      medido: {
        texto_visivel: evidence.visibleTextLength,
        elementos_visuais: evidence.visualElements,
        elementos: evidence.elementCount
      },
      ...buildVerdict(evidence, assercoes)
    };
  } catch (err) {
    return { disponivel: true, erro: `A validação falhou: ${trim(err?.message || err)}` };
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (server) await server.close(); } catch {}
    scheduleIdleClose();
  }
}
