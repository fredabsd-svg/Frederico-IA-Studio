import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { execInSandbox, workspaceFor, safeJoin, pcFolderMounts } from './sandbox.js';

export const toolDefinitions = [
  { type: 'function', function: { name: 'run_python', description: 'Executa Python 3.12 real na sandbox Linux isolada. Use para análises, planilhas, Word, PDF, gráficos, OCR, APIs e automações. Pacotes incluem pandas, numpy, openpyxl, python-docx, odfpy (importe odf), reportlab, weasyprint, PyMuPDF/fitz, pdfplumber, camelot, ocrmypdf, pytesseract, duckdb, polars, Flask/FastAPI/Uvicorn, pytest/black/ruff, SQLAlchemy, psycopg (v3), psycopg2 e clientes MySQL/Redis/MongoDB. Para ML em CPU: scikit-learn e onnxruntime para inferência; transformers, sentencepiece e safetensors para tokenização/configuração. Sem PyTorch/TensorFlow, use modelos ONNX com onnxruntime.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'bash', description: 'Executa comando bash na sandbox. Disponíveis: LibreOffice, ffmpeg, PDF/OCR, ImageMagick, Inkscape/rsvg-convert, Chromium headless/Xvfb/Playwright, gcc/g++/make/cmake/ninja, go, rustc/cargo, javac, dotnet (C#) e kotlinc 2.3.21 (Kotlin JVM), sqlite3/psql/mysql/redis-cli, ssh/rsync/ansible/kubectl, gdb/valgrind/strace/lsof/htop/shellcheck e Node/npm/yarn/pnpm com tsc/vite/sass/postcss/tailwindcss/prettier/eslint. TEM internet: curl/wget e instalações pip/npm funcionam; apt não funciona por ser usuário sem root. Docker/Compose, GPU e Android/iOS nativos são intencionalmente indisponíveis para preservar o isolamento.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
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
export function isBlockedHost(hostname) {
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
  let target;
  try { target = new URL(url); } catch { throw new Error('URL inválida.'); }
  let r;
  // Validate every redirect. A public URL must never be able to bounce the
  // backend into a private or metadata address.
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (isBlockedHost(target.hostname)) throw new Error('Endereço bloqueado por segurança (rede interna/local não é acessível).');
    r = await fetchWithTimeout(target, 20000, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(r.status)) break;
    const location = r.headers.get('location');
    if (!location) break;
    target = new URL(location, target);
    if (redirects === 4) throw new Error('A página redirecionou vezes demais.');
  }
  const type = r.headers.get('content-type') || '';
  if (!/text|html|json|xml/i.test(type)) return { url, note: `Conteúdo não textual (${type}). Baixe/processe de outra forma.` };
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
  return { url: target.toString(), status: r.status, content: text.slice(0, 8000) };
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

// O modelo enxerga /workspace e /mnt/user-data dentro da sandbox, enquanto
// estas ferramentas leves rodam no backend. Aceita os dois enderecos virtuais
// e os converte para a raiz real da conversa antes de acessar o arquivo.
export function workspaceRelativePath(userPath) {
  const raw = String(userPath || '').trim().replaceAll('\\', '/');
  return raw.replace(/^\/?(?:workspace|mnt\/user-data)(?:\/|$)/i, '');
}

// Arquivos do PC so existem dentro da sandbox, em /mnt/pc/<pasta-liberada>.
// Normalizar antes de comparar impede que ".." saia de uma pasta autorizada.
export function resolveMountedPcPath(userPath, mounts = pcFolderMounts()) {
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

async function readMountedPcFile(conversationId, mountedPath, sandboxOptions) {
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
  const result = await execInSandbox(conversationId, `python - <<'PY'\n${script}\nPY`, undefined, sandboxOptions);
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

export async function runTool(conversationId, name, args = {}, sandboxOptions = {}) {
  if (name === 'web_search') return JSON.stringify(await webSearch(args.query || ''));
  if (name === 'web_fetch') return JSON.stringify(await webFetch(args.url || ''));
  const ws = workspaceFor(conversationId);
  if (name === 'generate_image') return JSON.stringify(await generateImage(ws, args));
  if (name === 'run_python') {
    const script = safeJoin(ws.base, `.tmp_${Date.now()}_${nanoid(8)}.py`);
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
    if (resolveMountedPcPath(args.path)) throw new Error('write_file grava apenas no workspace da conversa. Para editar uma pasta do PC autorizada, use bash ou run_python.');
    const target = safeJoin(ws.base, workspaceRelativePath(args.path));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, args.content || '', 'utf8');
    try { fs.chownSync(target, 1000, 1000); fs.chownSync(path.dirname(target), 1000, 1000); } catch {}
    return JSON.stringify({ ok: true, path: args.path, size: fs.statSync(target).size });
  }
  if (name === 'read_file') {
    const mountedPath = resolveMountedPcPath(args.path);
    if (mountedPath) return readMountedPcFile(conversationId, mountedPath, sandboxOptions);
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
