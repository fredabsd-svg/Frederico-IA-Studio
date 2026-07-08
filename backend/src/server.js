import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from './db.js';
import { runAgent } from './agent.js';
import { workspaceFor, destroyConversation } from './sandbox.js';

const app = express();
const port = process.env.PORT || 3001;
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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
    const models = (data.data || []).map(m => ({
      id: m.id,
      name: m.name || m.id,
      tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null
    })).sort((a, b) => a.name.localeCompare(b.name));
    modelsCache = models; modelsCacheAt = Date.now();
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
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

app.get('/api/conversations/:id/download/*', (req, res) => {
  const ws = workspaceFor(req.params.id);
  const rel = req.params[0];
  const target = path.resolve(ws.base, rel);
  if (!target.startsWith(path.resolve(ws.base)) || !fs.existsSync(target)) return res.status(404).send('Arquivo não encontrado');
  res.download(target);
});

app.post('/api/conversations/:id/chat', async (req, res) => {
  ensureConversation(req.params.id, req.body?.model);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const text = req.body?.message || '';
    // Título automático: usa o início da 1ª mensagem em vez de "Nova conversa"
    const conv = db.prepare('SELECT title FROM conversations WHERE id=?').get(req.params.id);
    if (conv && (!conv.title?.trim() || conv.title === 'Nova conversa')) {
      const autoTitle = text.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (autoTitle) db.prepare('UPDATE conversations SET title=? WHERE id=?').run(autoTitle, req.params.id);
    }
    await runAgent({ conversationId: req.params.id, userText: text, model: req.body?.model, mode: req.body?.mode, onEvent: send });
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', content: err.message });
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

app.listen(port, () => console.log(`Frederico AI Studio backend em http://localhost:${port}`));
