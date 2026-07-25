// Camada de dados do copiloto: a conversa própria (isolada) e a caixa de
// documentos. Toda leitura/escrita é escopada por user_id (multi-tenant).
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { sanitizeDocInput } from './core.js';

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
