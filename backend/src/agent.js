import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { toolDefinitions, webToolDefinitions, runTool } from './tools.js';
import { workspaceFor } from './sandbox.js';
import { db, now } from './db.js';
import { nanoid } from 'nanoid';

// Lista os arquivos da pasta outputs (para detectar os que foram gerados)
function listOutputs(conversationId) {
  const ws = workspaceFor(conversationId);
  const acc = [];
  const walk = (dir) => { try { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, d.name); d.isDirectory() ? walk(full) : acc.push(full); } } catch {} };
  walk(ws.outputs);
  return acc.map(f => { const st = fs.statSync(f); return { path: path.relative(ws.base, f).replaceAll('\\', '/'), name: path.basename(f), size: st.size, mtimeMs: st.mtimeMs }; });
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
- PDF: run_python com pdfplumber (texto) ou pypdf; para PDFs escaneados, use pytesseract (OCR, idioma "por").
- Excel/CSV: run_python com pandas (pd.read_excel / pd.read_csv).
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
// Regras aplicadas a TODOS os assistentes: evitam que o modelo perca trabalho
// por assumir um "kernel" persistente que na verdade não existe.
const SANDBOX_RULES = `

REGRAS DO SANDBOX (muito importante):
- Cada execução de run_python é um processo NOVO e independente. Variáveis NÃO persistem entre chamadas — o que você definiu numa execução some na seguinte.
- Resolva a tarefa preferencialmente em UM ÚNICO script run_python, completo e autossuficiente: ler os arquivos, processar e salvar o resultado final de uma vez.
- Se precisar mesmo dividir em etapas, salve os dados intermediários em arquivo (JSON/CSV em /workspace) e leia de volta no próximo script — nunca dependa de variáveis da execução anterior.
- Evite muitas execuções exploratórias; planeje e faça de uma vez. Salve os arquivos finais em /workspace/outputs.`;

function promptFor(assistant) {
  const base = assistant ? (assistant.system_prompt || AGENTS.contabil.prompt) : AGENTS.contabil.prompt;
  return base + personalitySuffix(assistant?.personality) + SANDBOX_RULES;
}
function toolsFor(assistant) {
  const allowed = assistant?.tools;
  if (!Array.isArray(allowed) || !allowed.length) return toolDefinitions;
  return toolDefinitions.filter(t => allowed.includes(t.function.name));
}

// Memória: a global (todos os assistentes) + a específica do assistente atual
function memoryNote(assistantId) {
  const scopes = ['global'];
  if (assistantId) scopes.push(assistantId);
  let rows = [];
  try {
    const ph = scopes.map(() => '?').join(',');
    rows = db.prepare(`SELECT scope, content FROM memory WHERE scope IN (${ph}) ORDER BY created_at ASC`).all(...scopes);
  } catch {}
  if (!rows.length) return null;
  const global = rows.filter(r => r.scope === 'global').map(r => `- ${r.content}`);
  const mine = rows.filter(r => r.scope !== 'global').map(r => `- ${r.content}`);
  let out = '';
  if (global.length) out += `Informações permanentes sobre o usuário/empresa:\n${global.join('\n')}`;
  if (mine.length) out += `${out ? '\n\n' : ''}Memória específica deste assistente:\n${mine.join('\n')}`;
  return out || null;
}

function addUsage(acc, u) {
  if (!u) return;
  acc.prompt_tokens += u.prompt_tokens || 0;
  acc.completion_tokens += u.completion_tokens || 0;
  acc.total_tokens += u.total_tokens || 0;
}

// ---- Controle de execução (pausar / continuar / parar) ----
const controls = new Map(); // conversationId -> { paused, stopped }
export function setControl(conversationId, action) {
  const c = controls.get(conversationId) || { paused: false, stopped: false };
  if (action === 'pause') c.paused = true;
  else if (action === 'resume') c.paused = false;
  else if (action === 'stop') { c.stopped = true; c.paused = false; }
  controls.set(conversationId, c);
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

export async function runAgent({ conversationId, userText, model, assistant, webSearch, onEvent }) {
  const chosenModel = model || assistant?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const chosenPrompt = promptFor(assistant);
  let tools = toolsFor(assistant);
  if (webSearch) tools = [...tools, ...webToolDefinitions];
  const temperature = temperatureFor(assistant?.personality);
  saveMessage(conversationId, 'user', userText);
  const historyLimit = Number(process.env.AGENT_HISTORY_LIMIT || 60);
  const history = db.prepare(`
    SELECT role, content FROM (
      SELECT role, content, created_at FROM messages
      WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?
    ) ORDER BY created_at ASC`).all(conversationId, historyLimit);
  const messages = [{ role: 'system', content: chosenPrompt }];
  if (webSearch) messages.push({ role: 'system', content: 'O usuário ATIVOU a pesquisa na internet. Você pode usar web_search (buscar) e web_fetch (ler uma página). Use quando a pergunta envolver informações atuais ou externas (legislação, notícias, tabelas, cotações, prazos) e cite as fontes (links) na resposta.' });
  const memory = memoryNote(assistant?.id);
  if (memory) messages.push({ role: 'system', content: memory });
  const note = uploadsNote(conversationId);
  if (note) messages.push({ role: 'system', content: note });
  messages.push(...history.map(m => ({ role: m.role, content: m.content })));

  const control = initControl(conversationId);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const maxSteps = Number(process.env.AGENT_MAX_STEPS || 30);
  const outputsBefore = new Map(listOutputs(conversationId).map(f => [f.path, f.mtimeMs]));
  let finalText = '';
  let stopped = false;
  let completedNaturally = false;
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
      temperature,
      stream: true,
      stream_options: { include_usage: true }
    });
    for await (const chunk of stream) {
      if (chunk.usage) addUsage(usage, chunk.usage);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
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
      onEvent({ type: 'tool_start', name });
      let result;
      try { result = await runTool(conversationId, name, args); }
      catch (err) { result = JSON.stringify({ error: err.message }); }
      onEvent({ type: 'tool_result', name, content: result.slice(0, 2000) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    if (stopped) break;
  }
  controls.delete(conversationId);

  if (stopped) { onEvent({ type: 'status', content: 'Interrompido pelo usuário' }); if (!finalText.trim()) finalText = '_Processamento interrompido pelo usuário._'; }
  else if (!completedNaturally) {
    // Atingiu o limite de etapas ainda usando ferramentas: avisa o usuário
    const note = `\n\n_⚠️ Atingi o limite de ${maxSteps} etapas de processamento nesta tarefa. Ela ficou muito longa — provavelmente pela dificuldade de extrair os dados. Sugestão: peça em partes (ex.: 1º "extraia os lançamentos do Razão para um CSV", depois "gere a planilha DFC a partir do CSV")._`;
    finalText += note;
    onEvent({ type: 'delta', content: note });
  } else if (!finalText.trim()) finalText = 'Concluído.';
  const msgId = saveMessage(conversationId, 'assistant', finalText);
  // Detecta os arquivos gerados NESTA resposta e os anexa à mensagem
  const newFiles = listOutputs(conversationId).filter(f => outputsBefore.get(f.path) !== f.mtimeMs);
  if (newFiles.length) {
    const stmt = db.prepare('INSERT INTO files (id,conversation_id,message_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?,?)');
    const cards = [];
    for (const f of newFiles) { const id = nanoid(); stmt.run(id, conversationId, msgId, 'output', f.name, f.path, f.size, now()); cards.push({ id, name: f.name, path: f.path, size: f.size }); }
    onEvent({ type: 'files', files: cards });
  }
  return { text: finalText, usage, model: chosenModel };
}

// Orquestrador: aciona vários assistentes e um coordenador une as respostas
export async function runOrchestrator({ conversationId, userText, model, assistants = [], onEvent }) {
  saveMessage(conversationId, 'user', userText);
  const control = initControl(conversationId);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const coordModel = model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const memory = memoryNote();
  const perspectives = [];
  let stopped = false;

  for (const a of assistants) {
    if (await gate(control, onEvent)) { stopped = true; break; }
    onEvent({ type: 'status', content: `${a.emoji || '🧑'} ${a.name} analisando...` });
    onEvent({ type: 'tool_start', name: a.name });
    const sys = `${a.system_prompt}\n\nDê APENAS a sua perspectiva especializada e resumida sobre o pedido, focando na sua área. Não gere arquivos nem execute código.`;
    const msgs = [{ role: 'system', content: sys }];
    if (memory) msgs.push({ role: 'system', content: memory });
    msgs.push({ role: 'user', content: userText });
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

  let finalText = '';
  if (stopped || await gate(control, onEvent)) {
    controls.delete(conversationId);
    onEvent({ type: 'status', content: 'Interrompido pelo usuário' });
    finalText = perspectives.length ? perspectives.map(p => `### ${p.emoji || ''} ${p.name}\n${p.text}`).join('\n\n') : '_Processamento interrompido pelo usuário._';
    onEvent({ type: 'delta', content: finalText });
    saveMessage(conversationId, 'assistant', finalText);
    return { text: finalText, usage, model: coordModel };
  }

  onEvent({ type: 'status', content: 'Compilando a resposta final da equipe...' });
  const combined = perspectives.map(p => `### ${p.emoji || ''} ${p.name}\n${p.text}`).join('\n\n');
  const synthMsgs = [
    { role: 'system', content: 'Você é o coordenador de uma equipe de assistentes especializados. Combine as perspectivas abaixo em UMA resposta única, organizada e coesa, em português do Brasil, sem repetições. Use títulos por área quando ajudar e feche com um resumo prático.' },
    { role: 'user', content: `Pedido do usuário:\n${userText}\n\nPerspectivas da equipe:\n${combined}` }
  ];
  try {
    const stream = await client.chat.completions.create({ model: coordModel, messages: synthMsgs, temperature: 0.3, stream: true, stream_options: { include_usage: true } });
    for await (const chunk of stream) {
      if (chunk.usage) addUsage(usage, chunk.usage);
      const d = chunk.choices?.[0]?.delta?.content || '';
      if (d) { finalText += d; onEvent({ type: 'delta', content: d }); }
    }
  } catch (err) {
    finalText = `Não foi possível compilar a resposta final: ${err.message}`;
    onEvent({ type: 'delta', content: finalText });
  }
  controls.delete(conversationId);
  if (!finalText.trim()) { finalText = 'Concluído.'; onEvent({ type: 'delta', content: finalText }); }
  saveMessage(conversationId, 'assistant', finalText);
  return { text: finalText, usage, model: coordModel };
}

export function saveMessage(conversationId, role, content) {
  const id = nanoid();
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)')
    .run(id, conversationId, role, content, now());
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), conversationId);
  return id;
}
