import fs from 'fs';
import path from 'path';
import { execInSandbox, workspaceFor, safeJoin } from './sandbox.js';

export const toolDefinitions = [
  { type: 'function', function: { name: 'run_python', description: 'Executa Python 3.12 real na sandbox Linux isolada. Use para análises, planilhas, Word, PDF, gráficos, OCR e automações. Pacotes instalados incluem pandas, numpy, openpyxl, xlsxwriter, xlrd, pyxlsb, odfpy, python-docx, python-pptx, reportlab, weasyprint, PyMuPDF/fitz, pdfplumber, camelot, ocrmypdf, pytesseract, duckdb, polars, pyarrow, plotly, seaborn, num2words, xmltodict e jsonschema.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'bash', description: 'Executa comando bash na sandbox. Programas DISPONÍVEIS: soffice/LibreOffice headless (converter .xls/.ods/.doc/.odt/.pptx e gerar PDF), ffmpeg, pdftotext, ocrmypdf, tesseract, jq, xmlstarlet, qpdf, imagemagick, zip/unzip, node e java. TEM internet: curl/wget funcionam e dá para "pip install --user" e "npm install" (apt install NÃO — sem root).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Cria ou sobrescreve arquivo no workspace da sessão.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path','content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Lê um arquivo de texto do workspace da sessão.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'Lista arquivos enviados e gerados na sessão.', parameters: { type: 'object', properties: { folder: { type: 'string', enum: ['uploads','outputs','.'] } } } } },
  { type: 'function', function: { name: 'zip_outputs', description: 'Compacta a pasta outputs em um arquivo ZIP.', parameters: { type: 'object', properties: { zip_name: { type: 'string' } } } } }
];

// Ferramentas de busca web (rodam no BACKEND): entregam resultados prontos com
// fontes. O sandbox também tem rede direta para baixar dados/consumir APIs.
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

// Bloqueia endereços internos/loopback/link-local para evitar SSRF (o backend
// tem rede; o modelo pode ser induzido por conteúdo de uma página a buscar,
// ex., http://169.254.169.254/ de metadados de nuvem).
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;       // link-local / metadados de nuvem
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

async function webFetch(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL inválida (use http/https).');
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error('URL inválida.'); }
  if (isBlockedHost(host)) throw new Error('Endereço bloqueado por segurança (rede interna/local não é acessível).');
  const r = await fetchWithTimeout(url, 20000);
  const type = r.headers.get('content-type') || '';
  if (!/text|html|json|xml/i.test(type)) return { url, note: `Conteúdo não textual (${type}). Baixe/processe de outra forma.` };
  const body = await r.text();
  const text = /json/i.test(type) ? body : stripHtml(body);
  return { url, status: r.status, content: text.slice(0, 8000) };
}

// Geração/edição de IMAGENS com IA — roda no backend, usando o mesmo provedor
// (OpenRouter) e a mesma chave do chat. O modelo de imagem é configurável.
export const imageToolDefinitions = [
  { type: 'function', function: { name: 'generate_image', description: 'Gera uma IMAGEM nova com IA a partir de uma descrição, ou EDITA uma imagem existente (passe input_image com o caminho, ex.: uploads/foto.png). A imagem final é salva em outputs/ e exibida ao usuário automaticamente. Descreva o prompt em detalhes (estilo, cores, composição).', parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Descrição detalhada da imagem desejada ou da edição a fazer' }, input_image: { type: 'string', description: '(opcional) caminho de uma imagem do workspace para editar, ex.: uploads/logo.png' }, file_name: { type: 'string', description: '(opcional) nome do arquivo de saída, sem extensão' } }, required: ['prompt'] } } }
];

async function generateImage(ws, args) {
  const model = process.env.IMAGE_MODEL || 'google/gemini-2.5-flash-image';
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
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

// Rede ligada: curl/wget e instalações (pip/npm) são permitidos. Continuam
// bloqueados apenas comandos destrutivos ou que tentam escalar privilégios.
const blocked = ['rm -rf /', 'mkfs', ':(){', 'shutdown', 'reboot', 'docker ', 'sudo ', 'su '];
function guardCommand(command) {
  const lower = String(command).toLowerCase();
  for (const bad of blocked) if (lower.includes(bad)) throw new Error(`Comando bloqueado: ${bad}`);
}

export async function runTool(conversationId, name, args = {}, sandboxOptions = {}) {
  if (name === 'web_search') return JSON.stringify(await webSearch(args.query || ''));
  if (name === 'web_fetch') return JSON.stringify(await webFetch(args.url || ''));
  const ws = workspaceFor(conversationId);
  if (name === 'generate_image') return JSON.stringify(await generateImage(ws, args));
  if (name === 'run_python') {
    const script = safeJoin(ws.base, `.tmp_${Date.now()}.py`);
    fs.writeFileSync(script, args.code || '', 'utf8');
    try { fs.chownSync(script, 1000, 1000); } catch {}
    try {
      const result = await execInSandbox(conversationId, `python ${path.basename(script)}`, undefined, sandboxOptions);
      return JSON.stringify(result);
    } finally {
      try { fs.unlinkSync(script); } catch {}
    }
  }
  if (name === 'bash') {
    guardCommand(args.command || '');
    return JSON.stringify(await execInSandbox(conversationId, args.command, undefined, sandboxOptions));
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
      `cd /workspace && zip -r "outputs/${zip}" outputs -x "outputs/${zip}"`, undefined, sandboxOptions));
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
