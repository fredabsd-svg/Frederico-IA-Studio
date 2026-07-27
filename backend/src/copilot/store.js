// Camada de dados do copiloto: a conversa própria (isolada) e a caixa de
// documentos. Toda leitura/escrita é escopada por user_id (multi-tenant).
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { sanitizeDocInput, sanitizeNoteInput, sanitizePrefs } from './core.js';

// ---- Chat isolado -----------------------------------------------------------

// Devolve (ou cria) a thread única do copiloto para o usuário. O MVP mantém uma
// conversa contínua por usuário — separada por completo de conversations.
export async function ensureCopilotConversation(userId) {
  const existing = await db.prepare(
    'SELECT * FROM copilot_conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 1'
  ).get(userId);
  if (existing) return existing;
  const id = nanoid();
  const t = now();
  await db.prepare(
    'INSERT INTO copilot_conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)'
  ).run(id, userId, 'Conversa com o copiloto', t, t);
  return db.prepare('SELECT * FROM copilot_conversations WHERE id=? AND user_id=?').get(id, userId);
}

export function serializeMessage(m) {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.created_at };
}

export async function listCopilotMessages(userId, conversationId, limit = 200) {
  const rows = await db.prepare(
    'SELECT * FROM copilot_messages WHERE user_id=? AND conversation_id=? ORDER BY created_at ASC LIMIT ?'
  ).all(userId, conversationId, limit);
  return rows.map(serializeMessage);
}

export async function appendCopilotMessage(userId, conversationId, role, content) {
  const id = nanoid();
  const t = now();
  await db.prepare(
    'INSERT INTO copilot_messages (id,conversation_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)'
  ).run(id, conversationId, userId, role, String(content || ''), t);
  await db.prepare('UPDATE copilot_conversations SET updated_at=? WHERE id=? AND user_id=?').run(t, conversationId, userId);
  return { id, role, content: String(content || ''), createdAt: t };
}

// Limpa o histórico do copiloto (recomeçar do zero). Mantém a thread.
export async function clearCopilotConversation(userId, conversationId) {
  await db.prepare('DELETE FROM copilot_messages WHERE user_id=? AND conversation_id=?').run(userId, conversationId);
  await db.prepare('UPDATE copilot_conversations SET updated_at=? WHERE id=? AND user_id=?').run(now(), conversationId, userId);
}

// ---- Caixa de documentos ----------------------------------------------------

export function serializeDocument(d, { withContent = false } = {}) {
  const base = {
    id: d.id, kind: d.kind, name: d.name, mime: d.mime,
    size: d.size, createdAt: d.created_at, updatedAt: d.updated_at,
    meta: d.meta ? safeJson(d.meta) : null,
  };
  if (withContent) base.content = d.content;
  return base;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

export async function createDocument(userId, input) {
  const doc = sanitizeDocInput(input);
  const id = nanoid();
  const t = now();
  await db.prepare(
    `INSERT INTO copilot_documents (id,user_id,kind,name,mime,content,meta,size,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, userId, doc.kind, doc.name, doc.mime, doc.content, doc.meta, doc.size, t, t);
  return serializeDocument(
    await db.prepare('SELECT * FROM copilot_documents WHERE id=? AND user_id=?').get(id, userId),
    { withContent: true }
  );
}

export async function listDocuments(userId, { kind = null } = {}) {
  const rows = kind
    ? await db.prepare('SELECT * FROM copilot_documents WHERE user_id=? AND kind=? ORDER BY created_at DESC LIMIT 200').all(userId, kind)
    : await db.prepare('SELECT * FROM copilot_documents WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(userId);
  return rows.map(d => serializeDocument(d));
}

export async function getDocument(userId, id, { withContent = true } = {}) {
  const row = await db.prepare('SELECT * FROM copilot_documents WHERE id=? AND user_id=?').get(id, userId);
  return row ? serializeDocument(row, { withContent }) : null;
}

export async function deleteDocument(userId, id) {
  const r = await db.prepare('DELETE FROM copilot_documents WHERE id=? AND user_id=?').run(id, userId);
  return r.changes > 0;
}

// ---- Preferências do painel -------------------------------------------------

export async function readPrefs(userId) {
  const row = await db.prepare('SELECT prefs FROM copilot_prefs WHERE user_id=?').get(userId);
  if (!row) return sanitizePrefs({});
  let parsed = {};
  try { parsed = JSON.parse(row.prefs); } catch { parsed = {}; }
  return sanitizePrefs(parsed);
}

export async function savePrefs(userId, input) {
  const prefs = sanitizePrefs(input);
  await db.prepare(
    `INSERT INTO copilot_prefs (user_id, prefs, updated_at) VALUES (?,?,?)
     ON CONFLICT (user_id) DO UPDATE SET prefs=excluded.prefs, updated_at=excluded.updated_at`
  ).run(userId, JSON.stringify(prefs), now());
  return prefs;
}

// ---- Memória própria (notas) ------------------------------------------------

export function serializeNote(n) {
  return {
    id: n.id, kind: n.kind, content: n.content, source: n.source,
    pinned: !!n.pinned, createdAt: n.created_at, updatedAt: n.updated_at,
  };
}

// Fixadas primeiro, depois as mais recentes — é essa a ordem que entra no
// prompt, então o que o usuário fixou nunca cai fora pelo limite.
export async function listNotes(userId, { limit = 100 } = {}) {
  const rows = await db.prepare(
    'SELECT * FROM copilot_notes WHERE user_id=? ORDER BY pinned DESC, updated_at DESC LIMIT ?'
  ).all(userId, Math.min(200, limit));
  return rows.map(serializeNote);
}

export async function createNote(userId, input) {
  const note = sanitizeNoteInput(input);
  if (!note.content) return null;
  const id = nanoid();
  const t = now();
  await db.prepare(
    'INSERT INTO copilot_notes (id,user_id,kind,content,source,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, userId, note.kind, note.content, note.source, note.pinned ? 1 : 0, t, t);
  return serializeNote({ id, kind: note.kind, content: note.content, source: note.source, pinned: note.pinned, created_at: t, updated_at: t });
}

// Atualização parcial: só os campos presentes no patch mudam.
export async function updateNote(userId, id, patch = {}) {
  const row = await db.prepare('SELECT * FROM copilot_notes WHERE id=? AND user_id=?').get(id, userId);
  if (!row) return null;
  const merged = sanitizeNoteInput({
    kind: patch.kind ?? row.kind,
    content: patch.content ?? row.content,
    source: row.source,
    pinned: patch.pinned == null ? !!row.pinned : patch.pinned,
  });
  if (!merged.content) return null;
  const t = now();
  await db.prepare('UPDATE copilot_notes SET kind=?, content=?, pinned=?, updated_at=? WHERE id=? AND user_id=?')
    .run(merged.kind, merged.content, merged.pinned ? 1 : 0, t, id, userId);
  return serializeNote({ ...row, ...merged, pinned: merged.pinned, updated_at: t });
}

export async function deleteNote(userId, id) {
  const r = await db.prepare('DELETE FROM copilot_notes WHERE id=? AND user_id=?').run(id, userId);
  return r.changes > 0;
}

// ---- Leitura AUTORIZADA do chat principal -----------------------------------

// Devolve as últimas mensagens de UMA conversa do chat principal — e só se ela
// pertencer a quem pediu (o JOIN com conversations é o dono da autorização;
// messages não tem user_id, herda o dono da conversa).
// Nunca é chamada sem autorização explícita: quem decide é routes/copilot.js.
export async function readMainChatTail(userId, conversationId, limit = 6) {
  if (!conversationId) return { conversation: null, messages: [] };
  const conv = await db.prepare('SELECT id, title FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId);
  if (!conv) return { conversation: null, messages: [] };
  const rows = await db.prepare(
    `SELECT m.role, m.content FROM messages m
     WHERE m.conversation_id=?
     ORDER BY m.created_at DESC, m.seq DESC
     LIMIT ?`
  ).all(conversationId, Math.min(40, Math.max(1, limit)));
  return {
    conversation: { id: conv.id, title: conv.title },
    messages: rows.reverse().map(r => ({ role: r.role, content: r.content })),
  };
}
