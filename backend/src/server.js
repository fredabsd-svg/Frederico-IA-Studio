import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from './db.js';
import { spawn } from 'child_process';
import { runAgent, runOrchestrator, setControl, friendlyApiError, AGENTS } from './agent.js';
import { runTool } from './tools.js';
import { listMemories, addMemory, updateMemory, deleteMemory, deleteAllMemories, exportAll, reindexAll, getSettings, setSettings, looksSensitive } from './memory/memoryService.js';
import { startImport, importStatus } from './memory/indexer.js';
import { workspaceFor, destroyConversation, insideBase } from './sandbox.js';
import { authEnabled, makeToken, verifyToken, getCookie, passwordMatches, loginRateLimited } from './auth.js';

const app = express();
const port = process.env.PORT || 3001;
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

// ---- Autenticação (ativa somente quando APP_PASSWORD está definida) ----
app.post('/api/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, auth: false });
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  if (loginRateLimited(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  if (!passwordMatches(req.body?.password)) return res.status(401).json({ error: 'Senha incorreta.' });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `fred_session=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!authEnabled()) return next();
  if (req.path === '/login' || req.path === '/health') return next();
  if (verifyToken(getCookie(req, 'fred_session'))) return next();
  res.status(401).json({ error: 'Não autenticado' });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
function loadAssistant(id) {
  const a = id && db.prepare('SELECT * FROM assistants WHERE id=?').get(id);
  if (!a) return null;
  return { ...a, tools: safeParse(a.tools, []), personality: safeParse(a.personality, {}) };
}

// Cria os assistentes padrão na primeira execução
function seedAssistants() {
  if (db.prepare('SELECT COUNT(*) c FROM assistants').get().c > 0) return;
  const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-chat';
  const defaults = [
    { name: 'Contábil / Fiscal', emoji: '📊', prompt: AGENTS.contabil.prompt },
    { name: 'Programação (Codex)', emoji: '💻', prompt: AGENTS.codigo.prompt }
  ];
  const stmt = db.prepare('INSERT INTO assistants (id,name,emoji,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
  const t = now();
  for (const d of defaults) stmt.run(nanoid(), d.name, d.emoji, defaultModel, d.prompt, JSON.stringify([]), JSON.stringify({ form: 50, det: 50, criat: 20 }), t, t);
}
seedAssistants();

// Biblioteca inicial de templates de pedido (o usuário pode criar os seus)
function seedTemplates() {
  if (db.prepare('SELECT COUNT(*) c FROM templates').get().c > 0) return;
  const seeds = [
    { name: '📊 DFC (Demonstração do Fluxo de Caixa)', content: 'Analise o arquivo enviado (razão/extratos) e gere uma planilha Excel com a DFC pelo método direto: abas Resumo, DFC (Operacional, Investimento e Financiamento) e Lançamentos classificados. Valide que os líquidos por atividade batem entre as abas, que o saldo final = saldo inicial + variação, e que não há erros de fórmula. Formate profissionalmente (moeda R$, datas dd/mm/aaaa, cabeçalhos congelados) e inclua gráficos da evolução do caixa.' },
    { name: '💰 Fluxo de caixa projetado 12 meses', content: 'Gere uma planilha Excel de fluxo de caixa projetado para 12 meses, com seções de entradas e saídas por categoria, totais mensais, saldo acumulado, formatação profissional em tons de azul e um gráfico de linha com a evolução do saldo. Inclua uma aba de premissas editável.' },
    { name: '📄 Proposta comercial', content: 'Crie um documento Word com uma proposta comercial profissional contendo: capa com título e data, apresentação da empresa, escopo dos serviços, cronograma, investimento (tabela de valores), condições de pagamento, validade da proposta e espaço para assinaturas. Use linguagem formal e formatação elegante.' },
    { name: '⚖️ Petição (estrutura)', content: 'Crie um documento Word com a estrutura de uma petição: endereçamento, qualificação das partes, título da ação, seção DOS FATOS, seção DO DIREITO com espaço para fundamentação, DOS PEDIDOS numerados, valor da causa e fechamento com local, data e assinatura do advogado (nome e OAB). Deixe marcadores [PREENCHER] nos pontos que dependem do caso concreto.' },
    { name: '📝 Contrato de prestação de serviços', content: 'Crie um documento Word com um contrato de prestação de serviços completo: qualificação das partes (CONTRATANTE e CONTRATADA com espaços para dados), objeto, obrigações de cada parte, valor e forma de pagamento, prazo e vigência, rescisão, multas, confidencialidade, foro e assinaturas com testemunhas. Linguagem jurídica clara.' },
    { name: '📈 Relatório mensal', content: 'Analise os arquivos enviados e gere um relatório mensal em PDF com: capa, sumário executivo com os principais números, análise por seção com tabelas e gráficos, destaques e pontos de atenção do período, e conclusão com recomendações. Visual profissional e limpo.' }
  ];
  const stmt = db.prepare('INSERT INTO templates (id,name,content,created_at) VALUES (?,?,?,?)');
  const t = now();
  for (const s of seeds) stmt.run(nanoid(), s.name, s.content, t);
}
seedTemplates();

function ensureConversation(id, model) {
  const existing = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  if (existing) return existing;
  const t = now();
  db.prepare('INSERT INTO conversations (id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(id, 'Nova conversa', model || process.env.DEEPSEEK_MODEL || 'deepseek-chat', t, t);
  workspaceFor(id);
}

app.get('/api/health', (_, res) => res.json({ ok: true, name: 'Frederico AI Studio' }));

// Lista os modelos disponíveis no provedor configurado (ex.: catálogo do
// OpenRouter). Marca quais suportam "tools" (necessário p/ gerar arquivos).
let modelsCache = null, modelsCacheAt = 0;
app.get('/api/models', async (_, res) => {
  if (modelsCache && Date.now() - modelsCacheAt < 10 * 60 * 1000) return res.json({ models: modelsCache });
  try {
    const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
    const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ''}` } });
    const data = await r.json();
    const models = (data.data || []).map(m => {
      const out = m.architecture?.output_modalities || [];
      return {
        id: m.id,
        name: m.name || m.id,
        tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null,
        image: out.includes('image'),
        video: out.includes('video')
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    modelsCache = models; modelsCacheAt = Date.now();
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

// ---- Assistentes (Assistant Studio) ----
app.get('/api/assistants', (_, res) => {
  res.json(db.prepare('SELECT * FROM assistants ORDER BY created_at ASC').all()
    .map(a => ({ ...a, tools: safeParse(a.tools, []), personality: safeParse(a.personality, {}) })));
});

app.post('/api/assistants', (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim() || !b.system_prompt?.trim()) return res.status(400).json({ error: 'Nome e instruções são obrigatórios.' });
  const id = nanoid();
  const t = now();
  db.prepare('INSERT INTO assistants (id,name,emoji,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, b.name.trim(), b.emoji || '🤖', b.model || process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-chat', b.system_prompt, JSON.stringify(b.tools || []), JSON.stringify(b.personality || {}), t, t);
  res.json(loadAssistant(id));
});

app.put('/api/assistants/:id', (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT id FROM assistants WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Assistente não encontrado' });
  db.prepare('UPDATE assistants SET name=?, emoji=?, model=?, system_prompt=?, tools=?, personality=?, updated_at=? WHERE id=?')
    .run(b.name?.trim() || 'Assistente', b.emoji || '🤖', b.model || null, b.system_prompt || '', JSON.stringify(b.tools || []), JSON.stringify(b.personality || {}), now(), req.params.id);
  res.json(loadAssistant(req.params.id));
});

app.delete('/api/assistants/:id', (req, res) => {
  db.prepare('DELETE FROM assistants WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Clientes / Projetos ----
app.get('/api/clients', (_, res) => {
  res.json(db.prepare('SELECT * FROM clients ORDER BY name ASC').all());
});

app.post('/api/clients', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
  const id = nanoid();
  db.prepare('INSERT INTO clients (id,name,created_at) VALUES (?,?,?)').run(id, name, now());
  res.json({ id, name });
});

app.delete('/api/clients/:id', (req, res) => {
  // Não destrutivo: as conversas do cliente voltam para "Geral"
  db.prepare('UPDATE conversations SET client_id=NULL WHERE client_id=?').run(req.params.id);
  db.prepare('UPDATE conversation_chunks SET scope=? WHERE scope=?').run('global', `client:${req.params.id}`);
  db.prepare("DELETE FROM memory WHERE scope=?").run(`client:${req.params.id}`);
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Templates de pedido ----
app.get('/api/templates', (_, res) => {
  res.json(db.prepare('SELECT * FROM templates ORDER BY created_at ASC').all());
});

app.post('/api/templates', (req, res) => {
  const name = (req.body?.name || '').trim();
  const content = (req.body?.content || '').trim();
  if (!name || !content) return res.status(400).json({ error: 'Nome e conteúdo são obrigatórios.' });
  const id = nanoid();
  db.prepare('INSERT INTO templates (id,name,content,created_at) VALUES (?,?,?,?)').run(id, name, content, now());
  res.json({ id, name, content });
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Memória de longo prazo (Cérebro do Assistente) ----
app.get('/api/memories', async (req, res) => {
  try {
    res.json(await listMemories({ query: req.query.query || '', type: req.query.type || '', scope: req.query.scope || '' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/memories', async (req, res) => {
  try {
    const b = req.body || {};
    if (looksSensitive(b.content)) return res.status(400).json({ error: 'Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.' });
    res.json(await addMemory({ content: b.content, type: b.type || 'manual', scope: b.scope || 'global', importance: Number(b.importance) || 3, pinned: b.pinned ? 1 : 0, tags: b.tags || null, source_type: 'manual' }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/memories/:id', async (req, res) => {
  try {
    const m = await updateMemory(req.params.id, req.body || {});
    if (!m) return res.status(404).json({ error: 'Memória não encontrada' });
    res.json(m);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/memories/:id', (req, res) => { deleteMemory(req.params.id); res.json({ ok: true }); });

app.delete('/api/memories', (req, res) => {
  deleteAllMemories({ scope: req.query.scope || null, source_type: req.query.source_type || null });
  res.json({ ok: true });
});

app.get('/api/memories/export', (_, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="memoria-frederico-ai.json"');
  res.json(exportAll());
});

app.post('/api/memories/reindex', async (_, res) => {
  try { res.json(await reindexAll()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Inicia a importação em segundo plano; o progresso é consultado via /import-status
app.post('/api/memories/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const r = startImport(Buffer.from(req.file.originalname, 'latin1').toString('utf8'), req.file.buffer, req.query.scope || 'global');
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ started: true });
});

app.get('/api/memories/import-status', (_, res) => res.json(importStatus));

app.get('/api/memory-config', (_, res) => res.json(getSettings()));
app.put('/api/memory-config', (req, res) => res.json(setSettings(req.body || {})));

// Rotas legadas (compatibilidade com versões antigas da interface)
app.get('/api/memory', async (req, res) => {
  res.json(await listMemories({ scope: req.query.scope || 'global' }));
});
app.post('/api/memory', async (req, res) => {
  try { res.json(await addMemory({ content: req.body?.content, scope: req.body?.scope || 'global' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/memory/:id', (req, res) => { deleteMemory(req.params.id); res.json({ ok: true }); });

// ---- Analytics de uso (mensagens e tokens) ----
app.get('/api/analytics', (_, res) => {
  const totals = db.prepare('SELECT COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens FROM usage').get();
  const byAssistant = db.prepare(`
    SELECT COALESCE(a.name,'(sem assistente / equipe)') name, a.emoji,
           COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN assistants a ON a.id=u.assistant_id
    GROUP BY u.assistant_id ORDER BY tokens DESC`).all();
  const byModel = db.prepare('SELECT model, COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens FROM usage GROUP BY model ORDER BY tokens DESC').all();
  const byConversation = db.prepare(`
    SELECT COALESCE(c.title,'(conversa apagada)') title, COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN conversations c ON c.id=u.conversation_id
    GROUP BY u.conversation_id ORDER BY tokens DESC LIMIT 15`).all();
  res.json({ totals, byAssistant, byModel, byConversation });
});

app.get('/api/conversations', (req, res) => {
  const clientId = req.query.client || null;
  const rows = clientId
    ? db.prepare('SELECT * FROM conversations WHERE client_id=? ORDER BY updated_at DESC').all(clientId)
    : db.prepare('SELECT * FROM conversations WHERE client_id IS NULL ORDER BY updated_at DESC').all();
  res.json(rows);
});

app.post('/api/conversations', (req, res) => {
  const id = nanoid();
  const t = now();
  const title = req.body?.title || 'Nova conversa';
  const model = req.body?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const clientId = req.body?.clientId || null;
  db.prepare('INSERT INTO conversations (id,title,model,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, title, model, clientId, t, t);
  workspaceFor(id);
  res.json({ id, title, model, client_id: clientId, created_at: t, updated_at: t });
});

app.get('/api/conversations/:id', (req, res) => {
  ensureConversation(req.params.id);
  const conversation = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id);
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC').all(req.params.id);
  // Anexa a cada mensagem os arquivos que ela gerou
  const byMsg = {};
  for (const f of db.prepare('SELECT id,name,path,size,message_id FROM files WHERE conversation_id=? AND message_id IS NOT NULL').all(req.params.id)) {
    (byMsg[f.message_id] ||= []).push(f);
  }
  messages.forEach(m => {
    m.files = byMsg[m.id] || [];
    if (m.memory_meta) {
      try { m.memory = JSON.parse(m.memory_meta); } catch {}
    }
    delete m.memory_meta;
  });
  res.json({ conversation, messages });
});

app.delete('/api/conversations/:id', async (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT id FROM conversations WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Conversa não encontrada' });
  db.prepare('DELETE FROM conversations WHERE id=?').run(id); // cascade: messages + files
  // Privacidade: remove também o índice de memória desta conversa
  db.prepare('DELETE FROM conversation_chunks WHERE conversation_id=?').run(id);
  await destroyConversation(id); // remove container e pasta do workspace
  res.json({ ok: true });
});

app.post('/api/conversations/:id/upload', upload.array('files'), (req, res) => {
  ensureConversation(req.params.id);
  const ws = workspaceFor(req.params.id);
  const saved = [];
  for (const file of req.files || []) {
    // multer/busboy entrega originalname em latin1; reconverte para UTF-8
    // para não corromper acentos (ex.: "Razão.pdf" virava "RazÃ£o.pdf").
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safe = original.replace(/[^a-zA-Z0-9._ -]/g, '_');
    const name = `${Date.now()}_${safe}`;
    const target = path.join(ws.uploads, name);
    fs.writeFileSync(target, file.buffer);
    try { fs.chownSync(target, 1000, 1000); } catch {}
    const id = nanoid();
    db.prepare('INSERT INTO files (id,conversation_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.params.id, 'upload', original, `uploads/${name}`, file.size, now());
    saved.push({ id, name: original, path: `uploads/${name}`, size: file.size });
  }
  res.json({ files: saved });
});

app.get('/api/conversations/:id/files', (req, res) => {
  ensureConversation(req.params.id);
  const ws = workspaceFor(req.params.id);
  const outputFiles = walk(ws.outputs).map(p => {
    const rel = path.relative(ws.base, p).replaceAll('\\', '/');
    return { id: Buffer.from(rel).toString('base64url'), kind: 'output', name: path.basename(p), path: rel, size: fs.statSync(p).size };
  });
  const uploaded = db.prepare('SELECT id,kind,name,path,size,created_at FROM files WHERE conversation_id=?').all(req.params.id);
  res.json([...uploaded, ...outputFiles]);
});

app.delete('/api/conversations/:id/files/*', (req, res) => {
  const ws = workspaceFor(req.params.id);
  const rel = req.params[0];
  const target = path.resolve(ws.base, rel);
  if (!insideBase(ws.base, target)) return res.status(400).json({ error: 'Caminho inválido' });
  try { fs.rmSync(target, { force: true }); } catch {}
  db.prepare('DELETE FROM files WHERE conversation_id=? AND path=?').run(req.params.id, rel.replaceAll('\\', '/'));
  res.json({ ok: true });
});

app.get('/api/conversations/:id/download/*', (req, res) => {
  const ws = workspaceFor(req.params.id);
  const rel = req.params[0];
  const target = path.resolve(ws.base, rel);
  if (!insideBase(ws.base, target) || !fs.existsSync(target)) return res.status(404).send('Arquivo não encontrado');
  res.download(target);
});

// ---- Fila de tarefas (execução em segundo plano) ----
let taskWorkerBusy = false;
async function processTasks() {
  if (taskWorkerBusy) return;
  taskWorkerBusy = true;
  try {
    while (true) {
      const t = db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
      if (!t) break;
      db.prepare("UPDATE tasks SET status='running', started_at=?, progress_text='Iniciando...' WHERE id=?").run(now(), t.id);
      const setProg = (txt) => { try { db.prepare('UPDATE tasks SET progress_text=? WHERE id=?').run(String(txt).slice(0, 200), t.id); } catch {} };
      try {
        ensureConversation(t.conversation_id, t.model);
        const assistant = loadAssistant(t.assistant_id);
        const onEvent = (ev) => {
          if (ev.type === 'status') setProg(ev.content);
          else if (ev.type === 'tool_start') setProg(`Executando ${ev.name}...`);
        };
        const result = await runAgent({ conversationId: t.conversation_id, userText: t.prompt, model: t.model, assistant, webSearch: !!t.web_search, onEvent });
        if (result?.usage) {
          db.prepare('INSERT INTO usage (id,conversation_id,assistant_id,model,kind,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(nanoid(), t.conversation_id, t.assistant_id, result.model, 'tarefa', result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens, now());
        }
        db.prepare("UPDATE tasks SET status='done', finished_at=?, result_text=?, progress_text='Concluída' WHERE id=?")
          .run(now(), String(result?.text || '').slice(0, 300), t.id);
      } catch (err) {
        console.error('[tarefa]', err);
        db.prepare("UPDATE tasks SET status='error', finished_at=?, error=? WHERE id=?").run(now(), friendlyApiError(err), t.id);
      }
    }
  } finally { taskWorkerBusy = false; }
}

// Tarefas que estavam "rodando" quando o servidor caiu voltam para a fila
db.prepare("UPDATE tasks SET status='queued', progress_text='Reenfileirada após reinício' WHERE status='running'").run();
setTimeout(() => processTasks().catch(() => {}), 2000);

app.post('/api/tasks', (req, res) => {
  const message = (req.body?.message || '').trim();
  const convId = req.body?.conversationId;
  if (!message) return res.status(400).json({ error: 'Mensagem vazia.' });
  if (!convId) return res.status(400).json({ error: 'Conversa não informada.' });
  ensureConversation(convId, req.body?.model);
  const id = nanoid();
  db.prepare('INSERT INTO tasks (id,conversation_id,assistant_id,model,web_search,prompt,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, convId, req.body?.assistantId || null, req.body?.model || null, req.body?.webSearch ? 1 : 0, message, 'queued', now());
  processTasks().catch(() => {});
  res.json({ id, status: 'queued' });
});

app.get('/api/tasks', (_, res) => {
  res.json(db.prepare(`
    SELECT t.*, c.title conv_title FROM tasks t
    LEFT JOIN conversations c ON c.id=t.conversation_id
    ORDER BY t.created_at DESC LIMIT 20`).all());
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tarefa não encontrada' });
  if (t.status === 'queued') db.prepare("UPDATE tasks SET status='canceled', finished_at=? WHERE id=?").run(now(), t.id);
  else if (t.status === 'running') setControl(t.conversation_id, 'stop');
  res.json({ ok: true });
});

// Exporta a conversa como PDF ou Word (gerado dentro do sandbox)
const PY_EXPORT = [
  'import json',
  "d = json.load(open('/workspace/.export.json'))",
  "fmt = '__FMT__'",
  "out = '/workspace/outputs/__OUT__'",
  "role = {'user': 'Voce', 'assistant': 'Assistente'}",
  "if fmt == 'docx':",
  '    from docx import Document',
  '    doc = Document()',
  "    doc.add_heading(d['title'], 0)",
  "    for m in d['messages']:",
  '        p = doc.add_paragraph()',
  "        r = p.add_run(role.get(m['role'], m['role']) + ' - ' + m['created_at'][:16].replace('T', ' '))",
  '        r.bold = True',
  "        doc.add_paragraph(m['content'])",
  '    doc.save(out)',
  'else:',
  '    from reportlab.lib.pagesizes import A4',
  '    from reportlab.lib.styles import getSampleStyleSheet',
  '    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer',
  '    from xml.sax.saxutils import escape',
  '    styles = getSampleStyleSheet()',
  "    story = [Paragraph(escape(d['title']), styles['Title']), Spacer(1, 12)]",
  "    for m in d['messages']:",
  "        story.append(Paragraph('<b>' + role.get(m['role'], m['role']) + '</b> - ' + m['created_at'][:16].replace('T', ' '), styles['Heading4']))",
  "        for line in m['content'].split('\\n'):",
  '            if line.strip():',
  "                story.append(Paragraph(escape(line), styles['BodyText']))",
  '        story.append(Spacer(1, 10))',
  '    SimpleDocTemplate(out, pagesize=A4).build(story)',
  "print('OK')"
].join('\n');

app.post('/api/conversations/:id/export', async (req, res) => {
  try {
    const format = req.body?.format === 'docx' ? 'docx' : 'pdf';
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
    const messages = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC').all(req.params.id);
    if (!messages.length) return res.status(400).json({ error: 'A conversa ainda não tem mensagens.' });
    const ws = workspaceFor(req.params.id);
    const jsonPath = path.join(ws.base, '.export.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ title: conv.title, messages }), 'utf8');
    try { fs.chownSync(jsonPath, 1000, 1000); } catch {}
    const slug = (conv.title || 'conversa').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'conversa';
    const name = `conversa-${slug}.${format}`;
    const result = JSON.parse(await runTool(req.params.id, 'run_python', { code: PY_EXPORT.replace('__FMT__', format).replace('__OUT__', name) }));
    try { fs.rmSync(jsonPath, { force: true }); } catch {}
    if (result.exitCode !== 0) return res.status(500).json({ error: 'Falha ao exportar: ' + String(result.output).slice(-200) });
    res.json({ ok: true, path: `outputs/${name}`, name });
  } catch (err) {
    console.error('[export]', err);
    res.status(500).json({ error: 'Falha ao exportar a conversa.' });
  }
});

// Backup completo (banco + workspaces) num .tar.gz para download
app.get('/api/backup', (req, res) => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  const stamp = new Date().toISOString().slice(0, 10);
  const dataDir = path.dirname(path.resolve(process.env.DB_PATH || './data/app.sqlite'));
  const wsRoot = path.resolve(process.env.WORKSPACE_ROOT || './workspaces');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="frederico-backup-${stamp}.tar.gz"`);
  const args = ['-czf', '-', '-C', path.dirname(dataDir), path.basename(dataDir)];
  if (fs.existsSync(wsRoot)) args.push('-C', path.dirname(wsRoot), path.basename(wsRoot));
  const tar = spawn('tar', args);
  tar.stdout.pipe(res);
  tar.on('error', (err) => { console.error('[backup]', err); res.end(); });
});

// Edição de mensagem (estilo ChatGPT): remove a mensagem indicada e TUDO que
// veio depois dela na conversa, incluindo os arquivos gerados por essas
// mensagens — a conversa é regravada a partir dali.
app.post('/api/conversations/:id/truncate', (req, res) => {
  const msg = db.prepare('SELECT id, created_at FROM messages WHERE id=? AND conversation_id=?').get(req.body?.messageId, req.params.id);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
  const doomed = db.prepare('SELECT id FROM messages WHERE conversation_id=? AND created_at>=?').all(req.params.id, msg.created_at).map(r => r.id);
  if (doomed.length) {
    const ws = workspaceFor(req.params.id);
    const ph = doomed.map(() => '?').join(',');
    const orphanFiles = db.prepare(`SELECT path FROM files WHERE conversation_id=? AND message_id IN (${ph})`).all(req.params.id, ...doomed);
    for (const f of orphanFiles) {
      const target = path.resolve(ws.base, f.path);
      if (insideBase(ws.base, target)) { try { fs.rmSync(target, { force: true }); } catch {} }
    }
    db.prepare(`DELETE FROM files WHERE conversation_id=? AND message_id IN (${ph})`).run(req.params.id, ...doomed);
  }
  db.prepare('DELETE FROM messages WHERE conversation_id=? AND created_at>=?').run(req.params.id, msg.created_at);
  // Privacidade: limpa o índice e os resumos derivados das mensagens removidas
  // (os chunks serão reindexados conforme a conversa continuar)
  db.prepare('DELETE FROM conversation_chunks WHERE conversation_id=?').run(req.params.id);
  db.prepare('UPDATE conversations SET summary_short=NULL, summary_long=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true, removed: doomed.length });
});

// Pausar / continuar / parar o processamento em andamento
app.post('/api/conversations/:id/control', (req, res) => {
  const action = req.body?.action;
  if (!['pause', 'resume', 'stop'].includes(action)) return res.status(400).json({ error: 'Ação inválida.' });
  setControl(req.params.id, action);
  res.json({ ok: true, action });
});

app.post('/api/conversations/:id/chat', async (req, res) => {
  ensureConversation(req.params.id, req.body?.model);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  // Se o navegador desconectar (aba fechada/rede), interrompe a execução
  // para não continuar gastando tokens sem ninguém assistindo.
  // IMPORTANTE: usar o 'close' da RESPOSTA (res), não do pedido (req) — o
  // 'close' do req dispara assim que o corpo do POST termina de chegar, o
  // que interrompia toda resposta logo no primeiro token.
  res.on('close', () => { if (!res.writableEnded) setControl(req.params.id, 'stop'); });
  try {
    const text = req.body?.message || '';
    // Título automático: usa o início da 1ª mensagem em vez de "Nova conversa"
    const conv = db.prepare('SELECT title FROM conversations WHERE id=?').get(req.params.id);
    if (conv && (!conv.title?.trim() || conv.title === 'Nova conversa')) {
      const autoTitle = text.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (autoTitle) db.prepare('UPDATE conversations SET title=? WHERE id=?').run(autoTitle, req.params.id);
    }
    let result, kind = 'chat', usageAssistantId = req.body?.assistantId || null;
    if (req.body?.orchestrate) {
      const assistants = (req.body?.orchestrateIds || []).map(loadAssistant).filter(Boolean);
      kind = 'orquestrador'; usageAssistantId = null;
      result = await runOrchestrator({ conversationId: req.params.id, userText: text, model: req.body?.model, assistants, onEvent: send });
    } else {
      const assistant = loadAssistant(req.body?.assistantId);
      result = await runAgent({ conversationId: req.params.id, userText: text, model: req.body?.model, assistant, webSearch: !!req.body?.webSearch, onEvent: send });
    }
    // Registra o consumo de tokens para o painel de análises
    if (result?.usage) {
      db.prepare('INSERT INTO usage (id,conversation_id,assistant_id,model,kind,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(nanoid(), req.params.id, usageAssistantId, result.model, kind, result.usage.prompt_tokens, result.usage.completion_tokens, result.usage.total_tokens, now());
    }
    send({ type: 'done' });
  } catch (err) {
    console.error('[chat]', err);
    send({ type: 'error', content: friendlyApiError(err) });
  } finally {
    res.end();
  }
});

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full) : [full];
  });
}

// 404 padrão para rotas de API desconhecidas
app.use('/api', (_, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Tratador global de erros: loga o detalhe no servidor e devolve mensagem
// limpa ao cliente (sem stack trace).
app.use((err, req, res, _next) => {
  console.error('[erro]', req.method, req.path, err);
  if (res.headersSent) return res.end();
  const status = err.type === 'entity.parse.failed' ? 400 : err.status || 500;
  res.status(status).json({ error: status === 400 ? 'Requisição inválida (JSON malformado).' : 'Erro interno do servidor.' });
});

app.listen(port, () => console.log(`Frederico AI Studio backend em http://localhost:${port}`));
