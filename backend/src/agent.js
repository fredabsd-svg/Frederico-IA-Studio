import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { toolDefinitions, webToolDefinitions, imageToolDefinitions, runTool } from './tools.js';
import { buildContext, historyBudgetForModel, selectHistoryForContext } from './memory/contextBuilder.js';
import { indexAfterReply } from './memory/indexer.js';
import { getSettings } from './memory/memoryService.js';
import { execInSandbox, workspaceFor, pcFolderMounts } from './sandbox.js';
import { db, now } from './db.js';
import { nanoid } from 'nanoid';

// Esforço da IA: controla o raciocínio (reasoning effort — funciona de verdade
// nos modelos que raciocinam, via OpenRouter), o número máximo de etapas do
// loop agêntico e uma instrução de sistema. Assim vale para qualquer modelo.
const EFFORT = {
  minimo:   { reasoning: 'low',  steps: 6,  nudge: 'Seja direto e objetivo. Entregue a resposta no menor número de passos possível, sem análises extras.' },
  moderado: { reasoning: null,   steps: 14, nudge: null },
  alto:     { reasoning: 'high', steps: 24, nudge: 'Pense passo a passo e confira os números e os resultados das ferramentas antes de responder.' },
  extra:    { reasoning: 'high', steps: 40, nudge: 'Trabalhe com o máximo de cuidado: planeje, execute cada etapa, verifique os resultados e revise possíveis erros antes de finalizar.' }
};
const effortCfg = (e) => EFFORT[e] || EFFORT.moderado;

// Lista os arquivos da pasta outputs (para detectar os que foram gerados)
function listOutputs(conversationId) {
  const ws = workspaceFor(conversationId);
  const acc = [];
  const walk = (dir) => { try { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, d.name); d.isDirectory() ? walk(full) : acc.push(full); } } catch {} };
  walk(ws.outputs);
  return acc.map(f => { const st = fs.statSync(f); return { path: path.relative(ws.base, f).replaceAll('\\', '/'), name: path.basename(f), size: st.size, mtimeMs: st.mtimeMs }; });
}

function mentionsOutputPath(text) {
  return /(?:sandbox:)?(?:\/workspace\/|\/mnt\/user-data\/)?outputs\//i.test(String(text || ''));
}

async function recoverAlternateOutputs(conversationId) {
  const script = [
    'mkdir -p /workspace/outputs',
    'target="$(readlink -f /workspace/outputs)"',
    'for d in /mnt/user-data/outputs /mnt/data/outputs /mnt/data; do',
    '  [ -d "$d" ] || continue',
    '  src="$(readlink -f "$d" 2>/dev/null || true)"',
    '  [ "$src" = "$target" ] && continue',
    '  find "$d" -maxdepth 1 -type f -print0 | while IFS= read -r -d "" f; do cp -f "$f" "/workspace/outputs/$(basename "$f")"; done',
    'done'
  ].join('\n');
  try { await execInSandbox(conversationId, script, 15000); } catch {}
}

function referencedOutputFiles(text, files) {
  const byPath = new Map(files.map(f => [String(f.path || '').toLowerCase(), f]));
  const byName = new Map(files.map(f => [String(f.name || '').toLowerCase(), f]));
  const picked = new Map();
  const re = /(?:sandbox:)?(?:\/workspace\/|\/mnt\/user-data\/)?outputs\/([^\)\]\n\r]+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    let rel = `outputs/${String(m[1] || '').trim().replace(/^[/\\]+/, '').replaceAll('\\', '/')}`;
    try { rel = decodeURI(rel); } catch {}
    rel = rel.replace(/^outputs\/outputs\//i, 'outputs/');
    const found = byPath.get(rel.toLowerCase()) || byName.get(path.basename(rel).toLowerCase());
    if (found) picked.set(found.path, found);
  }
  return [...picked.values()];
}

// Avisa o modelo sobre as pastas reais do PC liberadas pelo usuário
function pcFoldersNote() {
  const mounts = pcFolderMounts();
  if (!mounts.length) return null;
  const list = mounts.map(m => `- ${m.target}  →  pasta "${m.label}" do computador do usuário (${m.writable ? 'LEITURA + ESCRITA: você pode ler, renomear, mover e organizar' : 'SOMENTE LEITURA: nunca altere/apague'})`).join('\n');
  return `PASTAS DO COMPUTADOR DO USUÁRIO disponíveis no sandbox (arquivos REAIS da máquina dele):
${list}

Como usar (via run_python ou bash, com os caminhos acima):
- Procurar/analisar: liste e leia os arquivos normalmente (os, pathlib, pandas, PyMuPDF...).
- Organizar (somente nas pastas marcadas LEITURA + ESCRITA): use shutil.move / os.rename para renomear e reorganizar.
- CUIDADO — são arquivos reais e insubstituíveis: NUNCA apague nada sem o usuário pedir explicitamente; prefira MOVER para uma subpasta (ex.: "_Organizado") em vez de excluir; confirme antes de operações em massa. Ao terminar, resuma o que foi alterado.`;
}

// Lista os arquivos enviados pelo usuário para avisar o modelo que eles já
// existem no sandbox (senão o modelo pede para "reenviar" um arquivo que já
// está lá). Retorna null se não houver uploads.
function uploadsNote(conversationId) {
  let files = [];
  try { files = fs.readdirSync(workspaceFor(conversationId).uploads); } catch {}
  if (!files.length) return null;
  const list = files.map(f => `- /workspace/uploads/${f}`).join('\n');
  return `O usuário JÁ enviou os arquivos abaixo — eles estão disponíveis no sandbox agora:
${list}

Não peça para o usuário reenviar. Para lê-los, use as ferramentas:
- PDF — siga esta ORDEM de estratégias até obter texto legível:
  1) PyMuPDF: import fitz; doc = fitz.open(caminho); page.get_text() — o extrator mais robusto.
  2) bash: pdftotext -layout arquivo.pdf - (preserva colunas de relatórios financeiros).
  3) Tabelas com linhas: camelot.read_pdf(caminho, pages='all') ou pdfplumber .extract_tables().
  4) PDF escaneado ou texto ilegível/sobreposto: OCR — bash: ocrmypdf -l por --force-ocr entrada.pdf saida.pdf e extraia da saída; ou pdf2image + pytesseract (lang='por').
  Valide a qualidade: se o texto sair embaralhado, tente a próxima estratégia em vez de insistir.
- Excel/CSV: run_python com pandas (pd.read_excel / pd.read_csv). Formatos legados suportados: .xls (xlrd), .xlsb (pyxlsb), .ods (odfpy) — o pandas detecta sozinho.
- Conversão de formatos (quando a leitura direta falhar ou o usuário pedir outro formato): o LibreOffice ESTÁ INSTALADO — use bash: soffice --headless --convert-to xlsx|pdf|docx --outdir /workspace/outputs "arquivo". Funciona para .xls, .doc, .odt, .pptx e para gerar PDF fiel de docx/xlsx.
- Texto simples: read_file.
Sempre comece analisando o arquivo antes de responder.`;
}

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
});

// Modos de assistente (cada um com um system prompt pré-definido).
// O usuário escolhe no seletor "Assistente" da interface.
export const AGENTS = {
  contabil: {
    label: 'Contábil / Fiscal',
    prompt: `Você é o Frederico AI Studio, um assistente profissional com sandbox Linux.
Responda em português do Brasil. Foque em contabilidade, fiscal, financeiro, Excel, Word, PDF e automação.
Quando o usuário pedir arquivos, gere arquivos reais dentro de /workspace/outputs usando Python.
Para Excel use openpyxl ou xlsxwriter; para Word use python-docx; para PDF use reportlab/weasyprint.
Sempre valide os arquivos gerados listando a pasta outputs. Não invente links: os links serão exibidos pelo sistema.
Não peça para o usuário compilar código quando você pode executar na sandbox.`
  },
  codigo: {
    label: 'Programação',
    prompt: `Você é o Frederico AI Studio no MODO PROGRAMAÇÃO: um engenheiro de software sênior com um sandbox Linux real.
Responda em português do Brasil, de forma objetiva e técnica.
Você PODE e DEVE escrever, executar e testar código usando as ferramentas (run_python, bash, write_file, read_file, list_files, zip_outputs).

Fluxo de trabalho:
- Antes de responder, EXECUTE o código no sandbox e confira o exit code; se der erro, corrija e rode de novo até funcionar.
- Salve os arquivos do projeto em /workspace/outputs para o usuário baixar. Em projetos com vários arquivos, crie a estrutura de pastas e use zip_outputs para empacotar tudo em um .zip.
- Mostre os trechos de código relevantes em blocos markdown com a linguagem correta, e explique de forma resumida o que fez e como rodar.

Limites importantes do sandbox:
- NÃO há internet: não é possível instalar pacotes novos (pip/npm) nem baixar nada. Use a biblioteca padrão do Python 3.12 e os pacotes já instalados (pandas, numpy, openpyxl, python-docx, reportlab, matplotlib, pillow, beautifulsoup4, lxml, etc.). Se algo exigir um pacote ausente, avise o usuário em vez de tentar instalar.
- A execução roda como usuário sem privilégios, com tempo limitado por comando. Divida tarefas longas.
- Python e shell são executados de verdade; para outras linguagens, escreva os arquivos e explique como o usuário roda na máquina dele.

Nunca invente links de download: o sistema exibe os arquivos automaticamente.`
  }
};

// Mantido por compatibilidade
export const systemPrompt = AGENTS.contabil.prompt;

// Ajusta o prompt conforme os sliders de personalidade do assistente
function personalitySuffix(p) {
  if (!p) return '';
  const parts = [];
  if (typeof p.form === 'number') parts.push(p.form >= 66 ? 'Use um tom bastante formal e profissional.' : p.form <= 33 ? 'Use um tom informal e descontraído.' : 'Use um tom cordial e profissional.');
  if (typeof p.det === 'number') parts.push(p.det >= 66 ? 'Dê respostas detalhadas, completas e bem explicadas.' : p.det <= 33 ? 'Seja conciso e direto ao ponto.' : 'Equilibre concisão e detalhe conforme a pergunta.');
  return parts.length ? `\n\nEstilo de resposta: ${parts.join(' ')}` : '';
}
function temperatureFor(p) {
  const c = p && typeof p.criat === 'number' ? p.criat : 20;
  return Math.min(0.9, Math.max(0.1, 0.1 + (c / 100) * 0.8));
}

const PYTHON_INVENTORY = [
  'Planilhas/dados: pandas, numpy, openpyxl, xlsxwriter, xlrd (.xls antigo), pyxlsb (.xlsb), odfpy (.ods), duckdb, polars, pyarrow, tabulate.',
  'Documentos/relatórios: python-docx, python-pptx, reportlab, weasyprint, jinja2, matplotlib, pillow, plotly, seaborn.',
  'PDF/OCR: PyMuPDF/fitz, pypdf, PyPDF2, pdfplumber, camelot, ocrmypdf, pdf2image, pytesseract (idioma por), opencv-python-headless.',
  'Fiscal/contábil BR: validate-docbr (CPF/CNPJ/PIS/CNH/título), num2words (valor por extenso pt_BR), xmltodict (NF-e/CT-e), signxml (XML-DSig offline), jsonschema (eSocial/Reinf/DCTFWeb), rapidfuzz, phonenumbers, unidecode, python-dateutil, pytz, tzdata, PyYAML.',
  'Web/texto offline: beautifulsoup4, lxml.'
];

const SHELL_INVENTORY = [
  'LibreOffice/soffice headless: converte .xls/.ods/.doc/.odt/.pptx e gera PDF fiel de documentos e planilhas.',
  'PDF/OCR: pdftotext, ocrmypdf, tesseract/tesseract-ocr-por, qpdf.',
  'Mídia: ffmpeg para cortar, juntar, converter, extrair áudio, redimensionar e legendar vídeo/áudio.',
  'Dados/documentos: jq (JSON), xmlstarlet (XML), imagemagick/convert, zip/unzip.',
  'Runtimes offline: node/npm para scripts JavaScript locais e java/default-jre-headless para validadores .jar.'
];

// Regras aplicadas a TODOS os assistentes: evitam que o modelo perca trabalho
// por assumir um "kernel" persistente que na verdade não existe.
const SANDBOX_RULES = `

REGRAS DO SANDBOX (muito importante):
- O app tem ferramentas reais. Nesta chamada, considere como utilizáveis apenas as ferramentas e capacidades listadas em "FERRAMENTAS E AMBIENTE DISPONÍVEIS NESTA CHAMADA".
- Quando o usuário pedir análise de arquivo, planilha, documento, PDF, imagem, áudio, vídeo ou automação, use as ferramentas disponíveis em vez de apenas explicar.
- Onde estão os arquivos: uploads do usuário ficam em /workspace/uploads; arquivos finais devem ser salvos em /workspace/outputs para aparecerem como download no chat.
- Caminho obrigatorio para arquivos finais: /workspace/outputs. Nao use sandbox:/mnt/user-data/outputs, /mnt/user-data/outputs nem links markdown inventados; o app cria o cartao de download automaticamente.
- Cada execução de run_python é um processo NOVO e independente. Variáveis NÃO persistem entre chamadas — o que você definiu numa execução some na seguinte.
- Resolva a tarefa preferencialmente em UM ÚNICO script run_python, completo e autossuficiente: ler os arquivos, processar e salvar o resultado final de uma vez.
- Se precisar mesmo dividir em etapas, salve os dados intermediários em arquivo (JSON/CSV em /workspace) e leia de volta no próximo script — nunca dependa de variáveis da execução anterior.
- Evite muitas execuções exploratórias; planeje e faça de uma vez. Salve os arquivos finais em /workspace/outputs.
- Para GERAR ou EDITAR IMAGENS com IA, use a ferramenta generate_image (não tente desenhar via matplotlib quando o usuário pedir uma imagem artística/realista).
- SEMPRE escreva uma frase curta explicando o que vai fazer ANTES de cada chamada de ferramenta, e verifique o resultado (exit code/erro) depois. Nunca encadeie ferramentas em silêncio.
- O sandbox NÃO tem internet e NÃO instala pacotes (pip/apt/npm sem rede). Use somente o inventário já instalado informado nesta chamada.
- SEM acesso à SEFAZ/Receita (sandbox sem rede): dá para LER, VALIDAR e ASSINAR XML fiscal offline, mas NÃO transmitir. Se algo exigir uma biblioteca fora desta lista, avise o usuário.`;

function promptFor(assistant) {
  const base = assistant ? (assistant.system_prompt || AGENTS.contabil.prompt) : AGENTS.contabil.prompt;
  return base + personalitySuffix(assistant?.personality) + SANDBOX_RULES;
}
function toolsFor(assistant) {
  const all = [...toolDefinitions, ...imageToolDefinitions];
  const allowed = assistant?.tools;
  if (!Array.isArray(allowed) || !allowed.length) return all;
  return all.filter(t => allowed.includes(t.function.name));
}

function toolAvailabilityNote(tools) {
  const names = new Set(tools.map(t => t.function.name));
  const lines = ['FERRAMENTAS E AMBIENTE DISPONÍVEIS NESTA CHAMADA:'];
  lines.push('Arquivos da conversa: uploads em /workspace/uploads; resultados finais em /workspace/outputs.');
  lines.push('Para entregar arquivo ao usuario, salve em /workspace/outputs e nao escreva link sandbox:/mnt/user-data/outputs; o chat anexa o download sozinho.');

  lines.push('Ferramentas do chat habilitadas para você:');
  if (names.has('run_python')) lines.push('- run_python: executar Python 3.12 real no sandbox.');
  if (names.has('bash')) lines.push('- bash: executar comandos Linux offline no sandbox.');
  if (names.has('write_file')) lines.push('- write_file: criar ou sobrescrever arquivos no workspace.');
  if (names.has('read_file')) lines.push('- read_file: ler arquivos de texto do workspace.');
  if (names.has('list_files')) lines.push('- list_files: listar uploads, outputs e arquivos da conversa.');
  if (names.has('zip_outputs')) lines.push('- zip_outputs: compactar /workspace/outputs em ZIP.');
  if (names.has('generate_image')) lines.push('- generate_image: gerar ou editar imagens com IA e salvar em outputs.');
  if (names.has('web_search')) lines.push('- web_search: pesquisar na internet pelo backend quando o globo estiver ativado.');
  if (names.has('web_fetch')) lines.push('- web_fetch: abrir uma página da internet encontrada na pesquisa.');
  if (!tools.length) lines.push('- Nenhuma ferramenta de execução foi habilitada para este assistente. Responda por texto e avise se a tarefa exigir ferramenta.');

  if (names.has('run_python')) {
    lines.push('Inventário Python instalado via run_python:');
    for (const item of PYTHON_INVENTORY) lines.push(`- ${item}`);
  }
  if (names.has('bash')) {
    lines.push('Inventário de shell instalado via bash:');
    for (const item of SHELL_INVENTORY) lines.push(`- ${item}`);
  }
  if (names.has('bash')) {
    lines.push('Exemplos úteis de LibreOffice: soffice --headless --convert-to xlsx --outdir /workspace/outputs arquivo.xls; soffice --headless --convert-to pdf --outdir /workspace/outputs relatorio.docx.');
  }
  if (names.has('run_python') || names.has('bash')) {
    lines.push('Estratégia para PDFs difíceis: PyMuPDF/fitz; pdftotext -layout; pdfplumber/camelot para tabelas; ocrmypdf; pdf2image + pytesseract com lang="por".');
  }
  lines.push('Não invente capacidades fora deste inventário. Se a ferramenta necessária não estiver habilitada, diga isso claramente ao usuário.');
  return lines.join('\n');
}

const TEAM_TOOL_AWARENESS = `CAPACIDADES DO APP:
O Frederico AI Studio tem sandbox com Python 3.12, bash, LibreOffice/soffice, ffmpeg, OCR/PDF, utilitários JSON/XML/PDF/imagem, Node.js, Java, geração de arquivos e ferramentas de imagem/web quando habilitadas.
No Modo Equipe, os especialistas individuais desta etapa NÃO executam ferramentas diretamente; eles analisam e orientam. Se a resposta final exigir arquivo, cálculo, conversão ou validação, indique claramente que isso deve ser executado pelas ferramentas do assistente principal.`;

// Memória: global (todos) + do assistente atual + do cliente da conversa
function clientScopeFor(conversationId) {
  try {
    const conv = db.prepare('SELECT client_id FROM conversations WHERE id=?').get(conversationId);
    return conv?.client_id ? `client:${conv.client_id}` : null;
  } catch { return null; }
}

function memoryNote(assistantId, clientScope) {
  const scopes = ['global'];
  if (assistantId) scopes.push(assistantId);
  if (clientScope) scopes.push(clientScope);
  let rows = [];
  try {
    const ph = scopes.map(() => '?').join(',');
    rows = db.prepare(`SELECT scope, content FROM memory WHERE scope IN (${ph}) ORDER BY created_at ASC`).all(...scopes);
  } catch {}
  if (!rows.length) return null;
  const global = rows.filter(r => r.scope === 'global').map(r => `- ${r.content}`);
  const client = rows.filter(r => r.scope === clientScope && clientScope).map(r => `- ${r.content}`);
  const mine = rows.filter(r => r.scope === assistantId && assistantId).map(r => `- ${r.content}`);
  let out = '';
  if (global.length) out += `Informações permanentes sobre o usuário/empresa:\n${global.join('\n')}`;
  if (client.length) out += `${out ? '\n\n' : ''}Informações sobre o CLIENTE desta conversa:\n${client.join('\n')}`;
  if (mine.length) out += `${out ? '\n\n' : ''}Memória específica deste assistente:\n${mine.join('\n')}`;
  return out || null;
}

function addUsage(acc, u) {
  if (!u) return;
  acc.prompt_tokens += u.prompt_tokens || 0;
  acc.completion_tokens += u.completion_tokens || 0;
  acc.total_tokens += u.total_tokens || 0;
}

// Valida automaticamente os arquivos gerados (abre? abas? erros de fórmula?)
const VALIDATABLE = /\.(xlsx|pdf|docx)$/i;
async function validateOutputs(conversationId, files, onEvent) {
  const targets = files.filter(f => VALIDATABLE.test(f.name)).slice(0, 5);
  if (!targets.length) return {};
  onEvent({ type: 'status', content: 'Validando arquivos gerados...' });
  const listJson = JSON.stringify(targets.map(f => f.path));
  const code = [
    'import json',
    `files = json.loads('''${listJson}''')`,
    'out = []',
    'ERRS = ("#REF!", "#VALUE!", "#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!")',
    'for rel in files:',
    "    p = '/workspace/' + rel",
    "    r = {'path': rel, 'ok': True, 'info': ''}",
    '    try:',
    "        ext = rel.lower().rsplit('.', 1)[-1]",
    "        if ext == 'xlsx':",
    '            from openpyxl import load_workbook',
    '            wb = load_workbook(p)',
    '            errs = 0',
    '            for ws in wb.worksheets:',
    '                for row in ws.iter_rows():',
    '                    for c in row:',
    '                        v = c.value',
    '                        if isinstance(v, str) and any(e in v for e in ERRS):',
    '                            errs += 1',
    "            r['info'] = str(len(wb.sheetnames)) + ' abas'",
    '            if errs:',
    "                r['ok'] = False",
    "                r['info'] += ', ' + str(errs) + ' celulas com erro de formula'",
    "        elif ext == 'pdf':",
    '            from pypdf import PdfReader',
    '            n = len(PdfReader(p).pages)',
    "            r['info'] = str(n) + ' paginas'",
    '            if n == 0:',
    "                r['ok'] = False",
    "        elif ext == 'docx':",
    '            from docx import Document',
    '            d = Document(p)',
    "            r['info'] = str(len(d.paragraphs)) + ' paragrafos'",
    '    except Exception as e:',
    "        r['ok'] = False",
    "        r['info'] = ('nao abre: ' + str(e))[:90]",
    '    out.append(r)',
    'print(json.dumps(out))'
  ].join('\n');
  try {
    const raw = await runTool(conversationId, 'run_python', { code });
    const r = JSON.parse(raw);
    if (r.exitCode !== 0) return {};
    const line = String(r.output || '').trim().split('\n').pop();
    return Object.fromEntries(JSON.parse(line).map(x => [x.path, { ok: x.ok, info: x.info }]));
  } catch { return {}; }
}

// Traduz erros comuns da API do provedor em mensagens claras em português
export function friendlyApiError(err) {
  const status = err?.status || err?.response?.status;
  const raw = String(err?.message || '');
  if (status === 401) return 'Chave da API inválida ou expirada. Confira a DEEPSEEK_API_KEY no arquivo .env.';
  if (status === 402) return 'Sem créditos no provedor (OpenRouter/DeepSeek). Adicione créditos na sua conta e tente de novo.';
  if (status === 429) return 'Limite de uso atingido (erro 429). Modelos GRATUITOS têm cota pequena e fila compartilhada — aguarde alguns minutos ou, melhor, escolha um modelo pago (ex.: DeepSeek Chat, que custa centavos).';
  if (status === 404) return 'Modelo não encontrado no provedor. Escolha outro modelo no seletor.';
  if (status >= 500) return 'O provedor do modelo está instável neste momento. Tente novamente em instantes.';
  return raw.slice(0, 300) || 'Erro inesperado ao falar com o modelo.';
}

// ---- Controle de execução (pausar / continuar / parar) ----
const controls = new Map(); // conversationId -> { paused, stopped }
export function setControl(conversationId, action) {
  // Só atua sobre uma execução ATIVA; nunca cria entradas (evita vazamento
  // quando o evento chega depois que a execução terminou).
  const c = controls.get(conversationId);
  if (!c) return null;
  if (action === 'pause') c.paused = true;
  else if (action === 'resume') c.paused = false;
  else if (action === 'stop') { c.stopped = true; c.paused = false; }
  return c;
}
function initControl(id) { const c = { paused: false, stopped: false }; controls.set(id, c); return c; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Espera enquanto pausado; retorna true se deve PARAR
async function gate(control, onEvent) {
  if (control.stopped) return true;
  if (control.paused) {
    onEvent({ type: 'status', content: 'Pausado' });
    while (control.paused && !control.stopped) await sleep(250);
    if (control.stopped) return true;
    onEvent({ type: 'status', content: 'Retomando...' });
  }
  return false;
}

export async function runAgent({ conversationId, userText, model, assistant, webSearch, effort, onEvent }) {
  const chosenModel = model || assistant?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const chosenPrompt = promptFor(assistant);
  const eff = effortCfg(effort);
  let tools = toolsFor(assistant);
  if (webSearch) tools = [...tools, ...webToolDefinitions];
  const temperature = temperatureFor(assistant?.personality);
  const userMsgId = saveMessage(conversationId, 'user', userText);
  // Economia de tokens: menos mensagens de histórico consideradas por resposta
  const historyLimit = getSettings().economy_mode ? 20 : Number(process.env.AGENT_HISTORY_LIMIT || 60);
  const messages = [{ role: 'system', content: chosenPrompt }, { role: 'system', content: toolAvailabilityNote(tools) }];
  if (eff.nudge) messages.push({ role: 'system', content: eff.nudge });
  if (webSearch) messages.push({ role: 'system', content: `VOCÊ TEM ACESSO À INTERNET NESTA CONVERSA — o usuário ativou a pesquisa web.
- Para buscar: ferramenta web_search. Para ler uma página: web_fetch.
- NUNCA diga que "não tem acesso à internet": você tem, através dessas duas ferramentas. Use-as para informações atuais/externas (legislação, notícias, tabelas, cotações, prazos) e cite as fontes (links).
- Atenção à diferença: o SANDBOX Python continua SEM rede (não tente pip install / requests / urllib lá dentro). Internet = somente via web_search/web_fetch. Se faltar uma biblioteca Python, diga qual é ao usuário em vez de tentar instalar.` });
  let memoryMeta = null;
  // Memória de longo prazo: perfil, notas, resumos e recuperação semântica
  try {
    const contextPlan = await buildContext({ conversationId, assistantId: assistant?.id, clientScope: clientScopeFor(conversationId), userText, historyLimit, model: chosenModel });
    const ctxBlocks = contextPlan.blocks || [];
    memoryMeta = contextPlan.meta || null;
    for (const b of ctxBlocks) messages.push({ role: 'system', content: b });
  } catch (err) {
    console.error('[memória] contexto indisponível nesta resposta:', err.message);
    const memory = memoryNote(assistant?.id, clientScopeFor(conversationId));
    if (memory) messages.push({ role: 'system', content: memory });
  }
  const note = uploadsNote(conversationId);
  if (note) messages.push({ role: 'system', content: note });
  const pcNote = pcFoldersNote();
  if (pcNote) messages.push({ role: 'system', content: pcNote });
  const historyPlan = selectHistoryForContext({
    conversationId,
    limit: historyLimit,
    budgetTokens: historyBudgetForModel(chosenModel, memoryMeta?.budget)
  });
  if (memoryMeta) {
    memoryMeta = { ...memoryMeta, history: historyPlan.meta };
    onEvent({ type: 'memory_context', memory: memoryMeta });
  }
  const history = historyPlan.rows;
  messages.push(...history.map(m => ({ role: m.role, content: m.content })));

  const control = initControl(conversationId);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const maxSteps = Number(process.env.AGENT_MAX_STEPS || eff.steps);
  const outputsBefore = new Map(listOutputs(conversationId).map(f => [f.path, f.mtimeMs]));
  let finalText = '';
  let stopped = false;
  let completedNaturally = false;
  let consecutiveFailures = 0;
  let repeatedError = '';
  try {
  for (let step = 0; step < maxSteps; step++) {
    if (await gate(control, onEvent)) { stopped = true; break; }
    onEvent({ type: 'status', content: step === 0 ? 'Pensando...' : 'Continuando...' });
    // Streaming: o texto é enviado token a token para a interface (tela viva)
    let content = '';
    const toolCalls = [];
    const stream = await client.chat.completions.create({
      model: chosenModel,
      messages,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(eff.reasoning ? { reasoning: { effort: eff.reasoning } } : {}),
      temperature,
      stream: true,
      stream_options: { include_usage: true }
    });
    let reasoningNotified = false;
    for await (const chunk of stream) {
      if (chunk.usage) addUsage(usage, chunk.usage);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      // Modelos de raciocínio (R1, o1...) emitem "pensamento" invisível antes
      // do texto — avisa o usuário para a tela não parecer travada.
      if ((delta.reasoning || delta.reasoning_content) && !reasoningNotified) {
        reasoningNotified = true;
        onEvent({ type: 'status', content: 'Raciocinando... (este modelo pensa antes de responder e pode demorar)' });
      }
      if (delta.content) { content += delta.content; finalText += delta.content; onEvent({ type: 'delta', content: delta.content }); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] = toolCalls[i] || { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
      if (control.stopped) { stopped = true; break; }
    }
    const stepToolCalls = toolCalls.filter(Boolean);
    // Reenvia só o que a API espera (evita campos extras como reasoning_content)
    messages.push({ role: 'assistant', content: content ?? '', ...(stepToolCalls.length ? { tool_calls: stepToolCalls } : {}) });
    if (stopped) break;
    if (!stepToolCalls.length) { completedNaturally = true; break; }
    for (const call of stepToolCalls) {
      if (await gate(control, onEvent)) { stopped = true; break; }
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      // Prévia do que a ferramenta vai executar (exibida na interface)
      const preview = String(args.code || args.command || args.prompt || args.path || args.query || args.url || '').slice(0, 400);
      onEvent({ type: 'tool_start', name, preview });
      let result;
      try { result = await runTool(conversationId, name, args); }
      catch (err) { result = JSON.stringify({ error: err.message }); }
      onEvent({ type: 'tool_result', name, content: result.slice(0, 2000) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      // Freio de loop: conta falhas consecutivas das ferramentas
      let failed = false;
      try { const r = JSON.parse(result); failed = !!r.error || (typeof r.exitCode === 'number' && r.exitCode !== 0); if (failed) repeatedError = String(r.error || r.output || '').slice(-300); } catch {}
      consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
    }
    if (stopped) break;
    if (consecutiveFailures >= 5) {
      const note = `\n\n_⚠️ Interrompi o processamento: as últimas ${consecutiveFailures} execuções falharam seguidas — o modelo está em loop de erro. Último erro:_\n\`\`\`\n${repeatedError || 'sem detalhe'}\n\`\`\`\n_Sugestão: tente um modelo da categoria "⭐ Melhores para planilhas e arquivos" ou divida o pedido em partes._`;
      finalText += note;
      onEvent({ type: 'delta', content: note });
      completedNaturally = true; // evita acumular também o aviso de limite de etapas
      break;
    }
  }
  } finally {
    controls.delete(conversationId);
  }

  if (stopped) {
    onEvent({ type: 'status', content: 'Interrompido pelo usuário' });
    if (!finalText.trim()) { finalText = '_Processamento interrompido pelo usuário._'; onEvent({ type: 'delta', content: finalText }); }
  }
  else if (!completedNaturally) {
    // Atingiu o limite de etapas ainda usando ferramentas: avisa o usuário
    const note = `\n\n_⚠️ Atingi o limite de ${maxSteps} etapas de processamento nesta tarefa. Ela ficou muito longa — provavelmente pela dificuldade de extrair os dados. Sugestão: peça em partes (ex.: 1º "extraia os lançamentos do Razão para um CSV", depois "gere a planilha DFC a partir do CSV")._`;
    finalText += note;
    onEvent({ type: 'delta', content: note });
  } else if (!finalText.trim()) {
    // O modelo terminou sem produzir texto: mostra algo na tela em vez de
    // deixar o balão vazio (bug de streaming corrigido).
    finalText = 'O modelo terminou sem gerar uma resposta em texto. Tente reformular o pedido ou escolher outro modelo.';
    onEvent({ type: 'delta', content: finalText });
  }
  const msgId = saveMessage(conversationId, 'assistant', finalText, { memoryMeta });
  // Detecta os arquivos gerados NESTA resposta e os anexa à mensagem
  let outputsAfter = listOutputs(conversationId);
  let newFiles = outputsAfter.filter(f => outputsBefore.get(f.path) !== f.mtimeMs);
  if (!newFiles.length && mentionsOutputPath(finalText)) {
    await recoverAlternateOutputs(conversationId);
    outputsAfter = listOutputs(conversationId);
    newFiles = outputsAfter.filter(f => outputsBefore.get(f.path) !== f.mtimeMs);
  }
  if (!newFiles.length && mentionsOutputPath(finalText)) newFiles = referencedOutputFiles(finalText, outputsAfter);
  if (newFiles.length) {
    const checks = stopped ? {} : await validateOutputs(conversationId, newFiles, onEvent);
    const stmt = db.prepare('INSERT INTO files (id,conversation_id,message_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?,?)');
    const cards = [];
    for (const f of newFiles) { const id = nanoid(); stmt.run(id, conversationId, msgId, 'output', f.name, f.path, f.size, now()); cards.push({ id, name: f.name, path: f.path, size: f.size, check: checks[f.path] }); }
    onEvent({ type: 'files', files: cards });
  }
  // Informa os ids reais salvos no banco (necessário para editar mensagens)
  onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: msgId });
  // Memória: indexa a troca e extrai fatos em segundo plano (não bloqueia)
  if (!stopped) indexAfterReply(conversationId).catch(() => {});
  return { text: finalText, usage, model: chosenModel, stopped };
}

// Orquestrador: aciona vários assistentes e um coordenador une as respostas
export async function runOrchestrator({ conversationId, userText, model, assistants = [], onEvent }) {
  const userMsgId = saveMessage(conversationId, 'user', userText);
  const control = initControl(conversationId);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const coordModel = model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  let memory = null;
  let memoryMeta = null;
  try {
    const contextPlan = await buildContext({ conversationId, assistantId: null, clientScope: clientScopeFor(conversationId), userText, model: coordModel });
    memory = (contextPlan.blocks || []).join('\n\n') || null;
    memoryMeta = contextPlan.meta || null;
    if (memoryMeta) onEvent({ type: 'memory_context', memory: memoryMeta });
  }
  catch { memory = memoryNote(null, clientScopeFor(conversationId)); }
  // Histórico da conversa (a mensagem atual do usuário já foi salva — exclui ela)
  const histRows = db.prepare(`
    SELECT role, content FROM (
      SELECT role, content, created_at FROM messages
      WHERE conversation_id=? ORDER BY created_at DESC LIMIT 13
    ) ORDER BY created_at ASC`).all(conversationId).slice(0, -1);
  const historyText = histRows.map(m => `${m.role === 'user' ? 'Usuário' : 'Equipe'}: ${String(m.content).slice(0, 600)}`).join('\n');
  const isFollowUp = histRows.some(m => m.role === 'assistant');

  async function streamCoordinator(msgs) {
    const stream = await client.chat.completions.create({ model: coordModel, messages: msgs, temperature: 0.3, stream: true, stream_options: { include_usage: true } });
    let text = '';
    for await (const chunk of stream) {
      if (chunk.usage) addUsage(usage, chunk.usage);
      const d = chunk.choices?.[0]?.delta?.content || '';
      if (d) { text += d; onEvent({ type: 'delta', content: d }); }
    }
    return text;
  }

  // Regra determinística (zero custo): a equipe completa é consultada UMA vez
  // por conversa (na primeira mensagem). Depois, o coordenador continua sozinho
  // com o histórico e a memória. O usuário pode forçar nova consulta escrevendo
  // "consulte a equipe" (ou "consulte os especialistas") na mensagem.
  const forceConsult = /consult\w*\s+(a\s+|os\s+|o\s+)?(equipe|especialistas|time|todos)/i.test(userText);
  const consult = (!isFollowUp || forceConsult) && assistants.length > 0;

  let finalText = '';
  const perspectives = [];
  let stopped = false;

  if (!consult) {
    // Continuação: o coordenador responde direto, com histórico e memória
    onEvent({ type: 'status', content: 'Coordenador respondendo (equipe consultada no início da conversa — escreva "consulte a equipe" para nova rodada)...' });
    const directMsgs = [
      { role: 'system', content: 'Você é o coordenador de uma equipe de assistentes especializados, no MEIO de uma conversa em andamento. Responda diretamente à nova mensagem em português do Brasil, usando o histórico e a memória. NÃO se reapresente, NÃO descreva a equipe, NÃO repita o que já foi alinhado — apenas continue o trabalho de onde parou.' }
    ];
    directMsgs.push({ role: 'system', content: TEAM_TOOL_AWARENESS });
    if (memory) directMsgs.push({ role: 'system', content: memory });
    for (const m of histRows) directMsgs.push({ role: m.role, content: String(m.content).slice(0, 2000) });
    directMsgs.push({ role: 'user', content: userText });
    try { finalText = await streamCoordinator(directMsgs); }
    catch (err) { finalText = `Não foi possível responder: ${err.message}`; onEvent({ type: 'delta', content: finalText }); }
  } else {
    for (const a of assistants) {
      if (await gate(control, onEvent)) { stopped = true; break; }
      onEvent({ type: 'status', content: `${a.emoji || '🧑'} ${a.name} analisando...` });
      onEvent({ type: 'tool_start', name: a.name });
      const sys = `${a.system_prompt}\n\n${TEAM_TOOL_AWARENESS}\n\nVocê faz parte de uma equipe que JÁ está conversando com o usuário. Considere o histórico e dê APENAS a sua perspectiva especializada sobre a NOVA mensagem, direto ao ponto — sem se apresentar, sem repetir o que a equipe já disse. Não gere arquivos nem execute código nesta etapa.`;
      const msgs = [{ role: 'system', content: sys }];
      if (memory) msgs.push({ role: 'system', content: memory });
      msgs.push({ role: 'user', content: historyText ? `Histórico recente da conversa:\n${historyText}\n\nNOVA mensagem do usuário:\n${userText}` : userText });
      try {
        const c = await client.chat.completions.create({ model: a.model || coordModel, messages: msgs, temperature: 0.3 });
        addUsage(usage, c.usage);
        const text = c.choices[0].message.content || '';
        perspectives.push({ name: a.name, emoji: a.emoji, text });
        onEvent({ type: 'tool_result', name: a.name, content: text.slice(0, 600) });
      } catch (err) {
        onEvent({ type: 'tool_result', name: a.name, content: `erro: ${err.message}` });
      }
    }

    if (stopped || await gate(control, onEvent)) {
      controls.delete(conversationId);
      onEvent({ type: 'status', content: 'Interrompido pelo usuário' });
      finalText = perspectives.length ? perspectives.map(p => `### ${p.emoji || ''} ${p.name}\n${p.text}`).join('\n\n') : '_Processamento interrompido pelo usuário._';
      onEvent({ type: 'delta', content: finalText });
      const stoppedMsgId = saveMessage(conversationId, 'assistant', finalText, { memoryMeta });
      onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: stoppedMsgId });
      return { text: finalText, usage, model: coordModel };
    }

    onEvent({ type: 'status', content: 'Compilando a resposta final da equipe...' });
    const combined = perspectives.map(p => `### ${p.emoji || ''} ${p.name}\n${p.text}`).join('\n\n');
    const synthMsgs = [
      { role: 'system', content: 'Você é o coordenador de uma equipe de assistentes especializados, numa conversa em andamento. Combine as perspectivas abaixo em UMA resposta única e coesa, em português do Brasil, que responda DIRETAMENTE à nova mensagem do usuário. NÃO se reapresente, NÃO descreva a equipe nem faça manifesto — vá ao ponto. Use títulos por área quando ajudar e feche com um resumo prático.' },
      { role: 'system', content: TEAM_TOOL_AWARENESS },
      { role: 'user', content: `${historyText ? `Histórico recente:\n${historyText}\n\n` : ''}NOVA mensagem do usuário:\n${userText}\n\nPerspectivas da equipe:\n${combined}` }
    ];
    try { finalText = await streamCoordinator(synthMsgs); }
    catch (err) { finalText = `Não foi possível compilar a resposta final: ${err.message}`; onEvent({ type: 'delta', content: finalText }); }
  }
  controls.delete(conversationId);
  if (!finalText.trim()) { finalText = 'Concluído.'; onEvent({ type: 'delta', content: finalText }); }
  const doneMsgId = saveMessage(conversationId, 'assistant', finalText, { memoryMeta });
  onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: doneMsgId });
  indexAfterReply(conversationId).catch(() => {});
  return { text: finalText, usage, model: coordModel };
}

export function saveMessage(conversationId, role, content, extra = {}) {
  const id = nanoid();
  const memoryMeta = extra.memoryMeta ? JSON.stringify(extra.memoryMeta).slice(0, 20000) : null;
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, memory_meta, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, conversationId, role, content, memoryMeta, now());
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), conversationId);
  return id;
}
