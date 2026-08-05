// Rotas de inbox — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { workspaceFor } from '../sandbox.js';
import { makeRouter, upload, scanOrReject, decodeUploadName, beginUpload, enforceUploadLimits, cleanupRequestUploads } from './helpers.js';
import { commitUploadedFile } from '../uploads.js';
import { resolveDefaultModelRef } from '../defaults.js';

const router = makeRouter();

// ---- Caixa de entrada de documentos (por cliente) ----
// Um lugar para acumular documentos de um cliente e, com 1 clique, abrir uma
// conversa nova já com todos anexados para a IA processar.
const inboxRoot = path.join(path.resolve(process.env.DATA_DIR || './data'), 'inbox');
function safeUserKey(userId) {
  return String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_') || 'anon';
}
function inboxDir(userId, client) {
  // Escopo por usuário: um usuário não pode ler a caixa de entrada de outro.
  const uKey = safeUserKey(userId);
  const key = String(client || 'geral').replace(/[^a-zA-Z0-9_-]/g, '_') || 'geral';
  const d = path.join(inboxRoot, uKey, key);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
router.get('/inbox/:client', (req, res) => {
  const d = inboxDir(req.userId, req.params.client);
  const files = fs.readdirSync(d).map(n => {
    let size = 0; try { size = fs.statSync(path.join(d, n)).size; } catch { return null; }
    // O prefixo gravado é `timestamp_contador_nanoid(6)_` — o casamento por
    // comprimento fixo preserva nomes originais que contêm "_" ou dígitos.
    return { stored: n, name: n.match(/^\d+_\d+_[\w-]{6}_(.*)$/)?.[1] ?? n.replace(/^\d+_/, ''), size };
  }).filter(Boolean);
  res.json(files);
});
router.post('/inbox/:client/upload', (req, res, next) => {
  const gate = beginUpload(req, res);
  if (!gate) return;
  res.on('close', gate.release);
  res.on('finish', gate.release);
  next();
}, upload.array('files'), async (req, res) => {
  try {
    const d = inboxDir(req.userId, req.params.client);
    if (!enforceUploadLimits(req, res, { quotaDir: path.join(inboxRoot, safeUserKey(req.userId)) })) return;
    const scan = await scanOrReject(res, req.files || [], req);
    if (!scan) return;
    let count = 0;
    for (const file of scan.clean) {
      const original = decodeUploadName(file.originalname);
      const safe = original.replace(/[^a-zA-Z0-9._ -]/g, '_');
      commitUploadedFile(file.path, path.join(d, `${Date.now()}_${count}_${nanoid(6)}_${safe}`));
      count++;
    }
    res.json({ ok: true, count, scanned: scan.scanned, scanStatus: scan.status, rejected: scan.rejected });
  } finally {
    cleanupRequestUploads(req);
  }
});
router.delete('/inbox/:client/:stored', (req, res) => {
  const d = inboxDir(req.userId, req.params.client);
  const target = path.join(d, path.basename(req.params.stored)); // basename evita traversal
  try { fs.rmSync(target, { force: true }); } catch {}
  res.json({ ok: true });
});
router.post('/inbox/:client/to-conversation', async (req, res) => {
  const d = inboxDir(req.userId, req.params.client);
  const files = fs.readdirSync(d);
  if (!files.length) return res.status(400).json({ error: 'A caixa de entrada está vazia.' });
  const convId = nanoid();
  const t = now();
  const clientId = req.params.client === 'geral' ? null : req.params.client;
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(convId, req.userId, `Documentos recebidos — ${t.slice(0, 10)}`, resolveDefaultModelRef(), clientId, t, t);
  const ws = workspaceFor(convId, req.userId);
  for (const n of files) {
    // Prefixo de comprimento fixo (nanoid(6)) — a versão antiga com `+_` guloso
    // comia até o último "_" e mutilava nomes como "Nota_Fiscal_123.pdf".
    const original = n.match(/^\d+_\d+_[\w-]{6}_(.*)$/)?.[1] ?? n.replace(/^\d+_\d+_/, '');
    const dest = path.join(ws.uploads, n);
    try {
      fs.copyFileSync(path.join(d, n), dest);
      try { fs.chownSync(dest, 1000, 1000); } catch {}
      const size = fs.statSync(dest).size;
      await db.prepare('INSERT INTO files (id,conversation_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(nanoid(), convId, 'upload', original, `uploads/${n}`, size, now());
      fs.rmSync(path.join(d, n), { force: true }); // move: some da caixa para não reprocessar
    } catch {}
  }
  res.json({ id: convId });
});

export default router;
