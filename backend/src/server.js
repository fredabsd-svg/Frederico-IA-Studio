import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from './db.js';
import { runAgent, runOrchestrator, setControl, friendlyApiError, AGENTS } from './agent.js';
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

// ---- Memória (scope 'global' ou id de um assistente) ----
app.get('/api/memory', (req, res) => {
  const scope = req.query.scope || 'global';
  res.json(db.prepare('SELECT id, content, created_at FROM memory WHERE scope=? ORDER BY created_at ASC').all(scope));
});

app.post('/api/memory', (req, res) => {
  const content = (req.body?.content || '').trim();
  const scope = req.body?.scope || 'global';
  if (!content) return res.status(400).json({ error: 'Conteúdo vazio.' });
  const id = nanoid();
  db.prepare('INSERT INTO memory (id, scope, content, created_at) VALUES (?, ?, ?, ?)').run(id, scope, content, now());
  res.json({ id, content });
});

app.delete('/api/memory/:id', (req, res) => {
  db.prepare('DELETE FROM memory WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Analytics de uso (mensagens e tokens) ----
app.get('/api/analytics', (_, res) => {
  const totals = db.prepare('SELECT COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens FROM usage').get();
  const byAssistant = db.prepare(`
    SELECT COALESCE(a.name,'(sem assistente / equipe)') name, a.emoji,
           COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN assistants a ON a.id=u.assistant_id
    GROUP BY u.assistant_id ORDER BY tokens DESC`).all();
  const byModel = db.prepare('SELECT model, COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens FROM usage GROUP BY model ORDER BY tokens DESC').all();
  res.json({ totals, byAssistant, byModel });
});

app.get('/api/conversations', (_, res) => {
  const rows = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
  res.json(rows);
});

app.post('/api/conversations', (req, res) => {
  const id = nanoid();
  const t = now();
  const title = req.body?.title || 'Nova conversa';
  const model = req.body?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  db.prepare('INSERT INTO conversations (id,title,model,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,title,model,t,t);
  workspaceFor(id);
  res.json({ id, title, model, created_at: t, updated_at: t });
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
  messages.forEach(m => { m.files = byMsg[m.id] || []; });
  res.json({ conversation, messages });
});

app.delete('/api/conversations/:id', async (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT id FROM conversations WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Conversa não encontrada' });
  db.prepare('DELETE FROM conversations WHERE id=?').run(id); // cascade: messages + files
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
