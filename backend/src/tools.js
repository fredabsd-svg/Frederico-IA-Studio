import fs from 'fs';
import path from 'path';
import { execInSandbox, workspaceFor, safeJoin } from './sandbox.js';

export const toolDefinitions = [
  { type: 'function', function: { name: 'run_python', description: 'Executa código Python na sandbox Linux isolada. Use para análises, planilhas, Word, PDF e gráficos.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'bash', description: 'Executa comando bash seguro na sandbox. Evite comandos destrutivos.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Cria ou sobrescreve arquivo no workspace da sessão.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path','content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Lê um arquivo de texto do workspace da sessão.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'Lista arquivos enviados e gerados na sessão.', parameters: { type: 'object', properties: { folder: { type: 'string', enum: ['uploads','outputs','.'] } } } } },
  { type: 'function', function: { name: 'zip_outputs', description: 'Compacta a pasta outputs em um arquivo ZIP.', parameters: { type: 'object', properties: { zip_name: { type: 'string' } } } } }
];

// Ferramentas de internet (rodam no BACKEND, que tem rede — o sandbox não tem).
// Só são oferecidas ao modelo quando o usuário liga o botão de pesquisa.
export const webToolDefinitions = [
  { type: 'function', function: { name: 'web_search', description: 'Pesquisa na internet e retorna os principais resultados (título, link e resumo). Use para informações atuais: notícias, legislação, tabelas, cotações, prazos.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Termos da pesquisa' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Abre uma página da web (URL) e retorna o texto dela. Use após web_search para ler o conteúdo de um resultado.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }
];

async function fetchWithTimeout(url, ms = 15000, options = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FredericoAIStudio/1.0', ...(options.headers || {}) } }); }
  finally { clearTimeout(t); }
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function webSearch(query) {
  // Com chaves do Google configuradas, usa a API oficial (Custom Search).
  const gKey = process.env.GOOGLE_API_KEY, gCx = process.env.GOOGLE_CSE_ID;
  if (gKey && gCx) {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(gKey)}&cx=${encodeURIComponent(gCx)}&num=6&q=${encodeURIComponent(query)}`;
    const r = await fetchWithTimeout(url);
    if (!r.ok) throw new Error(`Google API: HTTP ${r.status}`);
    const data = await r.json();
    return { engine: 'google', results: (data.items || []).map(i => ({ title: i.title, url: i.link, snippet: i.snippet })) };
  }
  // Sem chaves: DuckDuckGo (não exige cadastro)
  const r = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error(`Busca: HTTP ${r.status}`);
  const html = await r.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < 6) {
    let url = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    results.push({ title: stripHtml(m[2]), url, snippet: stripHtml(m[3] || '') });
  }
  return { engine: 'duckduckgo', results };
}

async function webFetch(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL inválida (use http/https).');
  const r = await fetchWithTimeout(url, 20000);
  const type = r.headers.get('content-type') || '';
  if (!/text|html|json|xml/i.test(type)) return { url, note: `Conteúdo não textual (${type}). Baixe/processe de outra forma.` };
  const body = await r.text();
  const text = /json/i.test(type) ? body : stripHtml(body);
  return { url, status: r.status, content: text.slice(0, 8000) };
}

const blocked = ['rm -rf /', 'mkfs', ':(){', 'shutdown', 'reboot', 'docker ', 'sudo ', 'su ', 'curl ', 'wget ', 'ssh ', 'scp '];
function guardCommand(command) {
  const lower = String(command).toLowerCase();
  for (const bad of blocked) if (lower.includes(bad)) throw new Error(`Comando bloqueado: ${bad}`);
}

export async function runTool(conversationId, name, args = {}) {
  if (name === 'web_search') return JSON.stringify(await webSearch(args.query || ''));
  if (name === 'web_fetch') return JSON.stringify(await webFetch(args.url || ''));
  const ws = workspaceFor(conversationId);
  if (name === 'run_python') {
    const script = safeJoin(ws.base, `.tmp_${Date.now()}.py`);
    fs.writeFileSync(script, args.code || '', 'utf8');
    try { fs.chownSync(script, 1000, 1000); } catch {}
    try {
      const result = await execInSandbox(conversationId, `python ${path.basename(script)}`);
      return JSON.stringify(result);
    } finally {
      try { fs.unlinkSync(script); } catch {}
    }
  }
  if (name === 'bash') {
    guardCommand(args.command || '');
    return JSON.stringify(await execInSandbox(conversationId, args.command));
  }
  if (name === 'write_file') {
    const target = safeJoin(ws.base, args.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, args.content || '', 'utf8');
    try { fs.chownSync(target, 1000, 1000); fs.chownSync(path.dirname(target), 1000, 1000); } catch {}
    return JSON.stringify({ ok: true, path: args.path, size: fs.statSync(target).size });
  }
  if (name === 'read_file') {
    const target = safeJoin(ws.base, args.path);
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
      `cd /workspace && zip -r "outputs/${zip}" outputs -x "outputs/${zip}"`));
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
