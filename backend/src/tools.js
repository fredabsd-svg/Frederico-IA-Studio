import fs from 'fs';
import path from 'path';
import net from 'net';
import dns from 'dns';
import { nanoid } from 'nanoid';
import { execInSandbox, workspaceFor, safeJoin, pcFolderMounts } from './sandbox.js';
import { runGithubTool } from './connectors/github.js';
import { createCache } from './cache.js';
import { captureThumbnail } from './agent/pageShot.js';
import { getUserProvider } from './userProvider.js';

// Cache de chamadas EXTERNAS caras/repetidas. Desligável com TOOL_CACHE=0
// (usado nos testes para isolar cada caso). Chaves e TTLs por tipo:
//   * CNPJ: dados cadastrais mudam raramente; TTL longo (12h) evita bater na
//     BrasilAPI/ReceitaWS de novo (a ReceitaWS grátis limita ~3 req/min).
//   * web_search: resultados variam com o tempo; TTL curto (10 min) só corta a
//     repetição da MESMA busca dentro de um intervalo curto.
const TOOL_CACHE_ENABLED = process.env.TOOL_CACHE !== '0';
const CNPJ_TTL_MS = Math.max(0, Number(process.env.CNPJ_CACHE_TTL_MS ?? 12 * 60 * 60 * 1000));
const WEBSEARCH_TTL_MS = Math.max(0, Number(process.env.WEBSEARCH_CACHE_TTL_MS ?? 10 * 60 * 1000));
const cnpjCache = createCache({ name: 'cnpj', max: 2000, ttl: CNPJ_TTL_MS });
const webSearchCache = createCache({ name: 'web_search', max: 500, ttl: WEBSEARCH_TTL_MS });

export const toolDefinitions = [
  { type: 'function', function: { name: 'run_python', description: 'Executa Python 3 real na sandbox Linux isolada. Use para análises, planilhas, Word, PDF, gráficos, OCR, APIs e automações. Pacotes incluem pandas, numpy, openpyxl, python-docx, odfpy (importe odf), reportlab, weasyprint, PyMuPDF/fitz, pdfplumber, camelot, ocrmypdf, pytesseract, duckdb, polars, Flask/FastAPI/Uvicorn, pytest/black/ruff, SQLAlchemy, psycopg (v3), psycopg2 e clientes MySQL/Redis/MongoDB. Para ML em CPU: scikit-learn e onnxruntime para inferência; transformers, sentencepiece e safetensors para tokenização/configuração. Sem PyTorch/TensorFlow, use modelos ONNX com onnxruntime.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'bash', description: 'Executa comando bash na sandbox. Disponíveis: LibreOffice, ffmpeg, PDF/OCR, ImageMagick, Inkscape/rsvg-convert, Chromium headless/Xvfb/Playwright, gcc/g++/make/cmake/ninja, go, rustc/cargo, javac, dotnet (C#) e kotlinc (Kotlin JVM), sqlite3/psql/mysql/redis-cli, ssh/rsync/ansible/kubectl, gdb/valgrind/strace/lsof/htop/shellcheck e Node/npm/yarn/pnpm com tsc/vite/sass/postcss/tailwindcss/prettier/eslint. A rede é desligada por padrão e só fica disponível quando o pedido atual a autoriza explicitamente; apt não funciona por ser usuário sem root. Docker/Compose, GPU e Android/iOS nativos são intencionalmente indisponíveis para preservar o isolamento.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Cria ou sobrescreve arquivo no workspace da sessão.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path','content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Lê um arquivo de texto do workspace da sessão.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'Lista arquivos enviados e gerados na sessão.', parameters: { type: 'object', properties: { folder: { type: 'string', enum: ['uploads','outputs','.'] } } } } },
  { type: 'function', function: { name: 'zip_outputs', description: 'Compacta a pasta outputs em um arquivo ZIP.', parameters: { type: 'object', properties: { zip_name: { type: 'string' } } } } },
  { type: 'function', function: { name: 'consultar_cnpj', description: 'Consulta os dados cadastrais OFICIAIS de um CNPJ nas bases públicas (BrasilAPI/ReceitaWS): razão social, nome fantasia, situação cadastral, natureza jurídica, porte, CNAE principal e secundários, endereço, telefone, e-mail, capital social, opção pelo Simples/MEI e quadro de sócios (QSA). Funciona SEM o botão de pesquisa. Use SEMPRE que o pedido envolver dados de uma empresa por CNPJ — NÃO use web_search para isso.', parameters: { type: 'object', properties: { cnpj: { type: 'string', description: 'CNPJ com ou sem pontuação (14 dígitos)' } }, required: ['cnpj'] } } }
];

// Ferramentas de busca web (rodam no BACKEND): entregam resultados prontos com
// fontes. A rede direta do sandbox é uma permissão separada e desligada por padrão.
// Só são oferecidas ao modelo quando o usuário liga o botão de pesquisa.
export const webToolDefinitions = [
  { type: 'function', function: { name: 'web_search', description: 'Pesquisa na internet e retorna os principais resultados (título, link e resumo). Use para informações atuais: notícias, legislação, tabelas, cotações, prazos.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Termos da pesquisa' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Abre uma página da web (URL) e retorna o texto dela. Use após web_search para ler o conteúdo de um resultado.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }
];

async function fetchWithTimeout(url, ms = 15000, options = {}) {
  const { signal: externalSignal, headers = {}, ...fetchOptions } = options;
  const ctl = new AbortController();
  const abortFromCaller = () => ctl.abort(externalSignal?.reason || 'aborted');
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const t = setTimeout(() => ctl.abort('timeout'), ms);
  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FredericoAIStudio/1.0', ...headers }
    });
  } finally {
    clearTimeout(t);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// DuckDuckGo entrega os links reais embrulhados num redirecionador
// (//duckduckgo.com/l/?uddg=<url-codificada>). Extrai a URL final e garante o
// esquema https quando o href vem sem protocolo (//host/...).
export function decodeDuckUrl(href) {
  let url = String(href || '').trim();
  const uddg = /[?&]uddg=([^&]+)/.exec(url);
  if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch {} }
  if (url.startsWith('//')) url = `https:${url}`;
  return url;
}

// Extrai âncoras <a> cuja classe contém `className`, SEM depender da ordem dos
// atributos (o href pode vir antes ou depois da class no HTML real).
function extractAnchors(html, className) {
  const out = [];
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const classRe = new RegExp(`class\\s*=\\s*['"][^'"]*\\b${className}\\b[^'"]*['"]`, 'i');
  let m;
  while ((m = aRe.exec(html))) {
    if (!classRe.test(m[1])) continue;
    const href = /href\s*=\s*['"]([^'"]+)['"]/i.exec(m[1])?.[1];
    out.push({ href: href || '', inner: m[2] });
  }
  return out;
}

// Extrai o texto de células <td> cuja classe contém `className`.
function extractTdText(html, className) {
  const out = [];
  const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  const classRe = new RegExp(`class\\s*=\\s*['"][^'"]*\\b${className}\\b[^'"]*['"]`, 'i');
  let m;
  while ((m = re.exec(html))) if (classRe.test(m[1])) out.push(stripHtml(m[2]));
  return out;
}

// Emparelha links e resumos pela ordem de aparição (índice preservado mesmo
// quando um link é descartado) e devolve no máximo `limit` resultados válidos.
function pairResults(links, snippets, limit) {
  const results = [];
  for (let i = 0; i < links.length && results.length < limit; i++) {
    const url = decodeDuckUrl(links[i].href);
    const title = stripHtml(links[i].inner);
    if (title && /^https?:\/\//i.test(url)) results.push({ title, url, snippet: snippets[i] || '' });
  }
  return results;
}

// Parser do HTML "normal" do DuckDuckGo (html.duckduckgo.com): links em
// result__a, resumos em result__snippet.
export function parseDuckHtml(html, limit = 6) {
  const links = extractAnchors(html, 'result__a');
  const snippets = extractAnchors(html, 'result__snippet').map(a => stripHtml(a.inner));
  return pairResults(links, snippets, limit);
}

// Parser da versão "lite" (lite.duckduckgo.com/lite) — layout de tabela, mais
// estável de raspar: links em result-link, resumos em células result-snippet.
export function parseDuckLite(html, limit = 6) {
  const links = extractAnchors(html, 'result-link');
  const snippets = extractTdText(html, 'result-snippet');
  return pairResults(links, snippets, limit);
}

// POST form-encoded imita o formulário do site (mais confiável que GET nesses
// endpoints) e fixa a região Brasil/Português (kl=br-pt) para resultados locais.
function duckFetch(endpoint, query, signal) {
  return fetchWithTimeout(endpoint, 15000, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `q=${encodeURIComponent(query)}&kl=br-pt`
  });
}

// Cacheia buscas idênticas por um TTL curto (só corta a repetição imediata da
// MESMA query). Erros/vazios não entram no cache — devem permitir nova tentativa.
async function webSearch(query, options = {}) {
  const q = String(query || '').trim();
  if (!q || !TOOL_CACHE_ENABLED) return webSearchUncached(query, options);
  const key = q.toLowerCase();
  const hit = webSearchCache.get(key);
  if (hit) return hit;
  const result = await webSearchUncached(query, options);
  if (result && Array.isArray(result.results) && result.results.length) webSearchCache.set(key, result);
  return result;
}

async function webSearchUncached(query, options = {}) {
  const q = String(query || '').trim();
  if (!q) return { engine: 'nenhum', results: [], erro: 'Consulta de pesquisa vazia.' };
  // Com chaves do Google configuradas, usa a API oficial (Custom Search).
  const gKey = process.env.GOOGLE_API_KEY, gCx = process.env.GOOGLE_CSE_ID;
  if (gKey && gCx) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(gKey)}&cx=${encodeURIComponent(gCx)}&num=6&q=${encodeURIComponent(q)}`;
      const r = await fetchWithTimeout(url, 15000, { signal: options.signal });
      if (r.ok) {
        const data = await r.json();
        const results = (data.items || []).map(i => ({ title: i.title, url: i.link, snippet: i.snippet }));
        if (results.length) return { engine: 'google', results };
      }
    } catch { /* cai para a busca gratuita abaixo */ }
  }
  // Sem chaves (ou Google falhou): DuckDuckGo gratuito, com dois endpoints de
  // reserva. Não exige cadastro.
  const attempts = [
    { engine: 'duckduckgo', url: 'https://html.duckduckgo.com/html/', parse: parseDuckHtml },
    { engine: 'duckduckgo-lite', url: 'https://lite.duckduckgo.com/lite/', parse: parseDuckLite }
  ];
  const problemas = [];
  for (const a of attempts) {
    try {
      const r = await duckFetch(a.url, q, options.signal);
      if (!r.ok) { problemas.push(`${a.engine} HTTP ${r.status}`); continue; }
      const results = a.parse(await r.text());
      if (results.length) return { engine: a.engine, results };
      problemas.push(`${a.engine}: 0 resultados`);
    } catch (e) { problemas.push(`${a.engine}: ${e.message}`); }
  }
  return {
    engine: 'nenhum',
    results: [],
    erro: 'A pesquisa gratuita não retornou resultados agora. Tente reformular os termos ou tente de novo em instantes.',
    detalhes: problemas
  };
}

// URLs com IPv6 chegam com colchetes no hostname ("[::1]"); remova-os antes de
// qualquer comparação, senão o literal escaparia de todos os testes abaixo.
function stripIpv6Brackets(hostname) {
  const s = String(hostname || '').trim();
  return s.length >= 2 && s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

// true se o IPv4 (pontilhado) pertence a uma faixa interna/reservada.
function isBlockedIpv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;           // link-local / metadados de nuvem
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                         // multicast/reservado (224/4, 240/4)
  return false;
}

// Extrai o IPv4 embutido num IPv6 mapeado, tanto na forma pontilhada
// (::ffff:127.0.0.1) quanto na hexadecimal que o parser WHATWG produz a partir
// dela (::ffff:7f00:1). Sem isto, http://[::ffff:127.0.0.1]/ furava o filtro.
function mappedIpv4(h) {
  let m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (m) return m[1];
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

// Bloqueia endereços internos/loopback/link-local para evitar SSRF (o backend
// tem rede; o modelo pode ser induzido por conteúdo de uma página a buscar,
// ex., http://169.254.169.254/ de metadados de nuvem). Aceita hostnames, IPv4
// (o parser WHATWG já normaliza decimal/octal/hex para pontilhado) e IPv6 —
// inclusive entre colchetes e na forma IPv4-mapeada.
export function isBlockedHost(hostname) {
  const h = stripIpv6Brackets(hostname).toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (isBlockedIpv4(h)) return true;
  if (h.includes(':')) {                               // IPv6 literal
    const mapped = mappedIpv4(h);
    if (mapped) return isBlockedIpv4(mapped);
    if (h === '::1' || h === '::') return true;        // loopback / não especificado
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(h)) return true;              // link-local fe80::/10
  }
  return false;
}

// Anti-DNS-rebinding: bloquear o hostname textualmente não basta — um domínio
// público pode resolver para 127.0.0.1/10.x/169.254.x. Resolvemos o nome e
// conferimos CADA IP retornado antes de conectar. (Resta uma janela TOCTOU
// mínima entre resolver e conectar; a mitigação padrão é validar aqui.)
async function assertHostResolvesPublic(hostname, signal) {
  const h = stripIpv6Brackets(hostname);
  if (net.isIP(h)) return; // IP literal já foi validado por isBlockedHost
  let addrs;
  try {
    // dns.promises.lookup não aceita AbortSignal; usamos a forma de callback e
    // ligamos o signal na mão para o cancelamento também valer durante o DNS.
    addrs = await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error(String(signal.reason || 'aborted')));
      const onAbort = () => reject(new Error(String(signal?.reason || 'aborted')));
      signal?.addEventListener('abort', onAbort, { once: true });
      dns.lookup(h, { all: true }, (err, result) => {
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(result);
      });
    });
  } catch (e) {
    if (signal?.aborted) throw e; // repassa o cancelamento intacto
    throw new Error('Não foi possível resolver o endereço da página.');
  }
  for (const { address } of addrs) {
    if (isBlockedHost(address)) throw new Error('Endereço bloqueado por segurança (rede interna/local não é acessível).');
  }
}

export async function webFetch(url, options = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL inválida (use http/https).');
  let target;
  try { target = new URL(url); } catch { throw new Error('URL inválida.'); }
  let r;
  // Validate every redirect. A public URL must never be able to bounce the
  // backend into a private or metadata address.
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (isBlockedHost(target.hostname)) throw new Error('Endereço bloqueado por segurança (rede interna/local não é acessível).');
    await assertHostResolvesPublic(target.hostname, options.signal);
    r = await fetchWithTimeout(target, 20000, { redirect: 'manual', signal: options.signal });
    if (![301, 302, 303, 307, 308].includes(r.status)) break;
    const location = r.headers.get('location');
    if (!location) break;
    target = new URL(location, target);
    if (redirects === 4) throw new Error('A página redirecionou vezes demais.');
  }
  if (!r) return { error: 'A página não respondeu à consulta.', code: 'WEB_FETCH_NO_RESPONSE', url: target.toString() };
  if (!r.ok) {
    const recoverable = [408, 425, 429, 500, 502, 503, 504].includes(r.status);
    return {
      error: `A página retornou HTTP ${r.status}.`,
      code: 'WEB_FETCH_HTTP_ERROR',
      status: r.status,
      url: target.toString(),
      recoverable
    };
  }
  const type = r.headers.get('content-type') || '';
  if (!/text|html|json|xml/i.test(type)) {
    return {
      error: `A página retornou conteúdo não textual (${type || 'tipo desconhecido'}).`,
      code: 'WEB_FETCH_UNREADABLE_CONTENT',
      status: r.status,
      url: target.toString()
    };
  }
  const declaredLength = Number(r.headers.get('content-length') || 0);
  const maxBytes = Math.max(64 * 1024, Number(process.env.WEB_FETCH_MAX_BYTES || 1_500_000));
  if (declaredLength > maxBytes) throw new Error('A página é grande demais para abrir com segurança.');
  const reader = r.body?.getReader();
  const chunks = [];
  let bytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('A página é grande demais para abrir com segurança.');
      }
      chunks.push(Buffer.from(value));
    }
  }
  const body = reader ? Buffer.concat(chunks).toString('utf8') : await r.text();
  const text = /json/i.test(type) ? body : stripHtml(body);
  if (!text.trim()) {
    return {
      error: 'A página não trouxe conteúdo textual utilizável.',
      code: 'WEB_FETCH_EMPTY_CONTENT',
      status: r.status,
      url: target.toString()
    };
  }
  return { url: target.toString(), status: r.status, content: text.slice(0, 8000) };
}

// ---- Consulta de CNPJ nas bases públicas (roda no BACKEND) ----
// Dados cadastrais de empresa vêm de APIs oficiais (JSON limpo), não de busca
// genérica. BrasilAPI é a fonte primária (grátis, sem cadastro); ReceitaWS é a
// reserva. Assim o assistente NÃO depende do botão de pesquisa nem do acaso do
// buscador para montar um relatório de CNPJ.
export function normalizeCnpj(value) {
  return String(value || '').replace(/\D/g, '');
}

// Normaliza o retorno da BrasilAPI para uma forma estável e em português.
function fromBrasilApi(d) {
  const endereco = [
    [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' '),
    d.numero, d.complemento, d.bairro,
    [d.municipio, d.uf].filter(Boolean).join('/'),
    d.cep
  ].filter(Boolean).join(', ');
  return {
    fonte: 'BrasilAPI',
    cnpj: d.cnpj,
    razao_social: d.razao_social || null,
    nome_fantasia: d.nome_fantasia || null,
    situacao_cadastral: d.descricao_situacao_cadastral || null,
    data_situacao_cadastral: d.data_situacao_cadastral || null,
    data_inicio_atividade: d.data_inicio_atividade || null,
    natureza_juridica: d.natureza_juridica || null,
    porte: d.porte || null,
    capital_social: d.capital_social ?? null,
    cnae_principal: d.cnae_fiscal ? `${d.cnae_fiscal} - ${d.cnae_fiscal_descricao || ''}`.trim() : null,
    cnaes_secundarios: Array.isArray(d.cnaes_secundarios)
      ? d.cnaes_secundarios.filter(c => c.codigo).map(c => `${c.codigo} - ${c.descricao || ''}`.trim()) : [],
    endereco,
    telefone: d.ddd_telefone_1 || null,
    email: d.email || null,
    opcao_simples: d.opcao_pelo_simples === true ? 'Sim' : (d.opcao_pelo_simples === false ? 'Não' : null),
    opcao_mei: d.opcao_pelo_mei === true ? 'Sim' : (d.opcao_pelo_mei === false ? 'Não' : null),
    socios: Array.isArray(d.qsa)
      ? d.qsa.map(s => ({ nome: s.nome_socio || s.nome || null, qualificacao: s.qualificacao_socio || null })) : []
  };
}

// Normaliza o retorno da ReceitaWS (nomes de campos diferentes).
function fromReceitaWs(d) {
  const endereco = [
    [d.logradouro, d.numero].filter(Boolean).join(', '),
    d.complemento, d.bairro,
    [d.municipio, d.uf].filter(Boolean).join('/'),
    d.cep
  ].filter(Boolean).join(', ');
  const ap = Array.isArray(d.atividade_principal) ? d.atividade_principal[0] : null;
  return {
    fonte: 'ReceitaWS',
    cnpj: d.cnpj || null,
    razao_social: d.nome || null,
    nome_fantasia: d.fantasia || null,
    situacao_cadastral: d.situacao || null,
    data_situacao_cadastral: d.data_situacao || null,
    data_inicio_atividade: d.abertura || null,
    natureza_juridica: d.natureza_juridica || null,
    porte: d.porte || null,
    capital_social: d.capital_social ?? null,
    cnae_principal: ap ? `${ap.code} - ${ap.text || ''}`.trim() : null,
    cnaes_secundarios: Array.isArray(d.atividades_secundarias)
      ? d.atividades_secundarias.filter(c => c.code && c.code !== '00.00-0-00').map(c => `${c.code} - ${c.text || ''}`.trim()) : [],
    endereco,
    telefone: d.telefone || null,
    email: d.email || null,
    opcao_simples: d.simples?.optante === true ? 'Sim' : (d.simples?.optante === false ? 'Não' : null),
    opcao_mei: d.simei?.optante === true ? 'Sim' : (d.simei?.optante === false ? 'Não' : null),
    socios: Array.isArray(d.qsa)
      ? d.qsa.map(s => ({ nome: s.nome || null, qualificacao: s.qual || null })) : []
  };
}

// Cacheia consultas de CNPJ por um TTL longo (dados cadastrais mudam raramente).
// Guarda só resultados DEFINITIVOS — sucesso ou "não encontrado" —; erros
// transitórios (base fora do ar) não entram no cache para permitir nova tentativa.
export async function consultarCnpj(cnpj, options = {}) {
  const digits = normalizeCnpj(cnpj);
  if (digits.length !== 14) {
    return { error: 'CNPJ inválido: informe os 14 dígitos (com ou sem pontuação).', code: 'CNPJ_INVALIDO', recoverable: true, requestedCnpj: cnpj };
  }
  if (TOOL_CACHE_ENABLED) {
    const hit = cnpjCache.get(digits);
    if (hit) return hit;
  }
  const result = await consultarCnpjUncached(digits, options);
  if (TOOL_CACHE_ENABLED && (!result.error || result.code === 'CNPJ_NAO_ENCONTRADO')) cnpjCache.set(digits, result);
  return result;
}

async function consultarCnpjUncached(digits, options = {}) {
  const problemas = [];
  // 1) BrasilAPI (primária)
  try {
    const r = await fetchWithTimeout(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, 15000, { signal: options.signal });
    if (r.ok) return fromBrasilApi(await r.json());
    if (r.status === 404) return { error: 'CNPJ não encontrado na base da Receita.', code: 'CNPJ_NAO_ENCONTRADO', recoverable: false, cnpj: digits };
    problemas.push(`BrasilAPI HTTP ${r.status}`);
  } catch (e) { problemas.push(`BrasilAPI: ${e.message}`); }
  // 2) ReceitaWS (reserva) — limita a ~3 consultas/min no plano grátis
  try {
    const r = await fetchWithTimeout(`https://receitaws.com.br/v1/cnpj/${digits}`, 15000, { signal: options.signal });
    if (r.ok) {
      const d = await r.json();
      if (d && d.status === 'ERROR') return { error: d.message || 'CNPJ não encontrado.', code: 'CNPJ_NAO_ENCONTRADO', recoverable: false, cnpj: digits };
      return fromReceitaWs(d);
    }
    problemas.push(`ReceitaWS HTTP ${r.status}`);
  } catch (e) { problemas.push(`ReceitaWS: ${e.message}`); }
  return {
    error: 'Não foi possível consultar o CNPJ agora nas bases públicas. Tente novamente em instantes.',
    code: 'CNPJ_CONSULTA_INDISPONIVEL',
    recoverable: true,
    cnpj: digits,
    detalhes: problemas
  };
}

// Geração/edição de IMAGENS com IA — roda no backend, usando o mesmo provedor
// (OpenRouter) e a mesma chave do chat. O modelo de imagem é configurável.
export const imageToolDefinitions = [
  { type: 'function', function: { name: 'generate_image', description: 'Gera uma IMAGEM nova com IA a partir de uma descrição, ou EDITA uma imagem existente (passe input_image com o caminho, ex.: uploads/foto.png). A imagem final é salva em outputs/ e exibida ao usuário automaticamente. Descreva o prompt em detalhes (estilo, cores, composição).', parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Descrição detalhada da imagem desejada ou da edição a fazer' }, input_image: { type: 'string', description: '(opcional) caminho de uma imagem do workspace para editar, ex.: uploads/logo.png' }, file_name: { type: 'string', description: '(opcional) nome do arquivo de saída, sem extensão' } }, required: ['prompt'] } } }
];

async function generateImage(ws, args, options = {}) {
  const model = process.env.IMAGE_MODEL || 'google/gemini-2.5-flash-image';
  // Usa o MESMO provedor/chave do chat deste usuário (BYOK/gratuito/servidor).
  // Antes fixava a chave/base do .env: num deploy sem chave própria do usuário
  // (ou usuário no modo gratuito) o header saía
  // "Bearer undefined" → 401, e a imagem nunca era gerada mesmo com o chat OK.
  const provider = await getUserProvider(options.userId, options.model);
  if (!provider.hasKey) {
    return { error: 'Nenhuma chave de API configurada para gerar imagens. Cadastre a sua chave em Configurações → Provedor de IA.', code: 'NO_API_KEY' };
  }
  const base = String(provider.baseURL || 'https://api.deepseek.com').replace(/\/$/, '');
  const content = [];
  if (args.input_image) {
    const src = safeJoin(ws.base, args.input_image);
    if (!fs.existsSync(src)) throw new Error(`Imagem de entrada não encontrada: ${args.input_image}`);
    const ext = path.extname(src).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png';
    content.push({ type: 'image_url', image_url: { url: `data:image/${ext};base64,${fs.readFileSync(src).toString('base64')}` } });
  }
  content.push({ type: 'text', text: args.prompt || '' });
  const r = await fetchWithTimeout(`${base}/chat/completions`, 120000, {
    method: 'POST',
    signal: options.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], modalities: ['image', 'text'] })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Geração de imagem falhou (HTTP ${r.status}). Verifique se o provedor é o OpenRouter e se o modelo de imagem "${model}" está disponível.`);
  const images = data.choices?.[0]?.message?.images || [];
  if (!images.length) return { error: 'O modelo não retornou imagem. Resposta: ' + String(data.choices?.[0]?.message?.content || '').slice(0, 200) };
  const saved = [];
  images.forEach((img, i) => {
    const url = img?.image_url?.url || img?.url || '';
    const m = /^data:image\/(\w+);base64,(.+)$/s.exec(url);
    if (!m) return;
    const cleanName = (args.file_name || 'imagem').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.(png|jpe?g|webp|gif)$/i, '');
    const fname = `${cleanName}${images.length > 1 ? '-' + (i + 1) : ''}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    const target = path.join(ws.outputs, fname);
    fs.writeFileSync(target, Buffer.from(m[2], 'base64'));
    try { fs.chownSync(target, 1000, 1000); } catch {}
    saved.push(`outputs/${fname}`);
  });
  if (!saved.length) return { error: 'Não foi possível decodificar a imagem retornada pelo modelo.' };
  return { ok: true, saved, note: 'Imagem salva em outputs — o sistema exibirá a prévia e o download ao usuário.' };
}

// A rede é controlada pela política do container (desligada por padrão).
// Independentemente dela, comandos destrutivos ou de escalada seguem bloqueados.
// Isto é defesa em profundidade — a fronteira real de segurança é o container
// (CapDrop ALL, no-new-privileges, uid 1000, mounts limitados). Mesmo assim,
// bloquear os padrões abaixo evita que código gerado apague os arquivos REAIS
// do usuário montados em /mnt/pc. Antes casava só substrings cruas, então
// "rm  -rf" (espaços duplos) e "find / -delete" escapavam.
const GUARD_PATTERNS = [
  { re: /\brm\b[^|;&]*-[a-z]*r[a-z]*f|\brm\b[^|;&]*-[a-z]*f[a-z]*r/, extra: /(\s|^)(\/|~|\/\*|\$home)(\s|\/|\*|$)/, msg: 'rm -rf em caminho de sistema' },
  { re: /--no-preserve-root/, msg: 'rm --no-preserve-root' },
  { re: /\bmkfs\b|\bmke2fs\b/, msg: 'formatar sistema de arquivos' },
  { re: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}|:\(\)\{.*:\|:/, msg: 'fork bomb' },
  { re: /(^|[\s;&|])(shutdown|reboot|halt|poweroff)\b|\binit\s+0\b/, msg: 'desligar/reiniciar o host' },
  { re: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|vd|mmc)/, msg: 'dd sobre dispositivo de bloco' },
  { re: />\s*\/dev\/(sd|nvme|hd|vd|mmc)/, msg: 'escrita direta em disco' },
  { re: /\bfind\b\s+(\/|~|\/mnt|\/home|\/etc|\/usr|\/var)[^|;&]*\s-delete\b/, msg: 'find -delete em caminho de sistema' },
  { re: /(^|[\s;&|])(sudo|doas)\s|(^|[\s;&|])su\s+-/, msg: 'escalonamento de privilégio' },
  { re: /(^|[\s;&|])docker(\s|$)|docker-compose/, msg: 'docker' },
  { re: /\bchmod\s+-r[^|;&]*\s\/(\s|$)|\bchown\s+-r[^|;&]*\s\/(\s|$)/, msg: 'chmod/chown recursivo na raiz' }
];
function guardCommand(command) {
  const norm = String(command || '').toLowerCase().replace(/[ \t]+/g, ' ').trim();
  for (const p of GUARD_PATTERNS) {
    if (!p.re.test(norm)) continue;
    if (p.extra && !p.extra.test(norm)) continue;
    throw new Error(`Comando bloqueado (${p.msg}). O sandbox é isolado e sem privilégios; esta operação é considerada perigosa e não será executada.`);
  }
}

// O modelo enxerga /workspace e /mnt/user-data dentro da sandbox, enquanto
// estas ferramentas leves rodam no backend. Aceita os dois enderecos virtuais
// e os converte para a raiz real da conversa antes de acessar o arquivo.
export function workspaceRelativePath(userPath) {
  const raw = String(userPath || '').trim().replaceAll('\\', '/');
  return raw.replace(/^\/?(?:workspace|mnt\/user-data)(?:\/|$)/i, '');
}

// Arquivos do PC so existem dentro da sandbox, em /mnt/pc/<pasta-liberada>.
// Normalizar antes de comparar impede que ".." saia de uma pasta autorizada.
export function resolveMountedPcPath(userPath, mounts = []) {
  const raw = String(userPath || '').trim().replaceAll('\\', '/');
  const normalized = path.posix.normalize(raw.startsWith('/') ? raw : `/${raw}`);
  return mounts.some(mount => normalized === mount.target || normalized.startsWith(`${mount.target}/`))
    ? normalized
    : null;
}

function missingFileResult(ws, requestedPath) {
  return {
    error: 'Arquivo nao encontrado nesta conversa.',
    code: 'ENOENT',
    recoverable: true,
    requestedPath,
    availableFiles: walk(ws.base).map(file => path.relative(ws.base, file).replaceAll('\\', '/')).slice(0, 120),
    hint: 'Use a lista de arquivos disponiveis ou list_files antes de tentar outro caminho.'
  };
}

async function readMountedPcFile(conversationId, mountedPath, sandboxOptions, runtime = {}) {
  const encodedPath = Buffer.from(mountedPath, 'utf8').toString('base64');
  const script = [
    'import base64, json',
    `target = base64.b64decode('${encodedPath}').decode('utf-8')`,
    'try:',
    "  with open(target, 'r', encoding='utf-8', errors='replace') as handle:",
    '    content = handle.read(6000)',
    "  print(json.dumps({'ok': True, 'path': target, 'content': content}, ensure_ascii=False))",
    'except Exception as error:',
    "  print(json.dumps({'error': str(error), 'code': getattr(error, 'errno', None), 'recoverable': True, 'requestedPath': target, 'hint': 'Confira o caminho dentro da pasta montada antes de tentar novamente.'}, ensure_ascii=False))"
  ].join('\n');
  const result = await execInSandbox(conversationId, `python - <<'PY'\n${script}\nPY`, undefined, { ...sandboxOptions, signal: runtime.signal });
  try {
    return JSON.stringify(JSON.parse(result.output.trim()));
  } catch {
    return JSON.stringify({
      error: 'Nao foi possivel ler o arquivo na pasta montada.',
      code: result.exitCode || 'READ_FAILED',
      recoverable: true,
      requestedPath: mountedPath,
      hint: 'Confira o caminho dentro da pasta montada antes de tentar novamente.'
    });
  }
}

export async function runTool(conversationId, name, args = {}, sandboxOptions = {}, runtime = {}) {
  const signal = runtime?.signal;
  if (name === 'web_search') return JSON.stringify(await webSearch(args.query || '', { signal }));
  if (name === 'web_fetch') {
    const res = await webFetch(args.url || '', { signal });
    // Miniatura da página (best-effort): renderiza a URL final já validada e
    // salva um JPEG no workspace. Se o navegador não estiver disponível ou
    // falhar, `thumb` fica ausente e o web_fetch segue igual (só o texto).
    if (res && !res.error && res.url) {
      try {
        const ws = workspaceFor(conversationId);
        const rel = path.posix.join('.thumbs', `${nanoid(10)}.jpg`);
        const ok = await captureThumbnail(res.url, path.join(ws.base, '.thumbs', path.basename(rel)), { signal });
        if (ok) res.thumb = rel;
      } catch {}
    }
    return JSON.stringify(res);
  }
  if (name === 'consultar_cnpj') return JSON.stringify(await consultarCnpj(args.cnpj || '', { signal }));
  // Conector GitHub: roda no BACKEND (o token do usuário nunca entra no sandbox).
  if (name.startsWith('github_')) return JSON.stringify(await runGithubTool(name, args, { userId: sandboxOptions.userId, conversationId, signal }));
  const ws = workspaceFor(conversationId);
  // Pastas do PC deste usuário (isolamento multi-tenant): sem userId, nenhuma.
  const pcMounts = pcFolderMounts(sandboxOptions.userId);
  if (name === 'generate_image') return JSON.stringify(await generateImage(ws, args, { signal, userId: sandboxOptions.userId }));
  if (name === 'run_python') {
    const script = safeJoin(ws.base, `.tmp_${Date.now()}_${nanoid(8)}.py`);
    fs.writeFileSync(script, args.code || '', 'utf8');
    try { fs.chownSync(script, 1000, 1000); } catch {}
    try {
      const result = await execInSandbox(conversationId, `python ${path.basename(script)}`, runtime.timeoutMs, { ...sandboxOptions, signal });
      return JSON.stringify(result);
    } finally {
      try { fs.unlinkSync(script); } catch {}
    }
  }
  if (name === 'bash') {
    guardCommand(args.command || '');
    return JSON.stringify(await execInSandbox(conversationId, args.command, runtime.timeoutMs, { ...sandboxOptions, signal }));
  }
  if (name === 'write_file') {
    if (resolveMountedPcPath(args.path, pcMounts)) throw new Error('write_file grava apenas no workspace da conversa. Para editar uma pasta do PC autorizada, use bash ou run_python.');
    const target = safeJoin(ws.base, workspaceRelativePath(args.path));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, args.content || '', 'utf8');
    try { fs.chownSync(target, 1000, 1000); fs.chownSync(path.dirname(target), 1000, 1000); } catch {}
    return JSON.stringify({ ok: true, path: args.path, size: fs.statSync(target).size });
  }
  if (name === 'read_file') {
    const mountedPath = resolveMountedPcPath(args.path, pcMounts);
    if (mountedPath) return readMountedPcFile(conversationId, mountedPath, sandboxOptions, { signal });
    const target = safeJoin(ws.base, workspaceRelativePath(args.path));
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return JSON.stringify(missingFileResult(ws, args.path));
    const content = fs.readFileSync(target, 'utf8');
    return JSON.stringify({ path: args.path, content: content.slice(0, 30000) });
  }
  if (name === 'list_files') {
    const folder = args.folder || '.';
    const base = folder === '.' ? ws.base : safeJoin(ws.base, folder);
    const files = walk(base).map(p => path.relative(ws.base, p));
    return JSON.stringify({ files });
  }
  if (name === 'zip_outputs') {
    const zip = (args.zip_name || 'outputs.zip').replace(/[^a-zA-Z0-9._-]/g, '_');
    return JSON.stringify(await execInSandbox(conversationId,
      `cd /workspace && zip -r "outputs/${zip}" outputs -x "outputs/${zip}"`, undefined, { ...sandboxOptions, signal }));
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full) : [full];
  });
}
