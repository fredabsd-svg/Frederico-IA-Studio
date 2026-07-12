import { db, now } from '../db.js';
import { nanoid } from 'nanoid';
import { embed, embedOne, cosine, keywordScore, embeddingsDegraded } from './embeddings.js';

// ---- Configurações da memória (tabela settings) ----
export const DEFAULT_SETTINGS = {
  memory_enabled: 1,          // memória ligada/desligada
  auto_memory: 1,             // extração automática de fatos
  review_auto_memory: 1,      // fatos aprendidos entram em fila para revisão
  context_target_tokens: 60000, // alvo do Context Builder (suba p/ modelos de 1M)
  max_memories: 12,           // memórias recuperadas por resposta
  max_chunks: 10,             // trechos de conversas antigas por resposta
  importance_threshold: 2     // importância mínima p/ salvar memória automática
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in out) out[r.key] = Number(r.value);
  return out;
}

export function setSettings(partial) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(partial || {})) {
    if (k in DEFAULT_SETTINGS && v !== undefined && v !== null && !Number.isNaN(Number(v))) stmt.run(k, String(Number(v)));
  }
  return getSettings();
}

// ---- Proteção: nunca salvar segredos automaticamente ----
const SENSITIVE = /(sk-[a-z0-9-]{8,}|api[_-]?key|senha|password|token\s*[:=]|bearer\s+[a-z0-9._-]{10,}|-----BEGIN)/i;
export function looksSensitive(text) { return SENSITIVE.test(String(text || '')); }

// ---- CRUD de memórias ----
export async function addMemory({ content, type = 'manual', scope = 'global', importance = 3, confidence = 1, tags = null, source_type = 'manual', source_id = null, pinned = 0 }) {
  content = String(content || '').trim();
  if (!content) throw new Error('Conteúdo vazio.');
  if (looksSensitive(content)) throw new Error('Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.');
  const [vec] = await embed([content], 'passage');
  const id = nanoid();
  const t = now();
  db.prepare(`INSERT INTO memory (id, scope, content, type, source_type, source_id, importance, confidence, pinned, tags, created_at, updated_at, embedding)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, scope, content, type, source_type, source_id, importance, confidence, pinned ? 1 : 0, tags, t, t, vec);
  return getMemory(id);
}

export function getMemory(id) {
  const m = db.prepare('SELECT * FROM memory WHERE id=?').get(id);
  if (m) delete m.embedding;
  return m;
}

export async function updateMemory(id, fields = {}) {
  const cur = db.prepare('SELECT * FROM memory WHERE id=?').get(id);
  if (!cur) return null;
  const content = fields.content !== undefined ? String(fields.content).trim() : cur.content;
  if (fields.content !== undefined && looksSensitive(content)) throw new Error('Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.');
  const vec = fields.content !== undefined && content !== cur.content ? await embedOne(content, 'passage') : cur.embedding;
  db.prepare(`UPDATE memory SET content=?, type=?, scope=?, importance=?, pinned=?, tags=?, updated_at=?, embedding=? WHERE id=?`)
    .run(content,
      fields.type !== undefined ? fields.type : cur.type,
      fields.scope !== undefined ? fields.scope : cur.scope,
      fields.importance !== undefined ? Number(fields.importance) : cur.importance,
      fields.pinned !== undefined ? (fields.pinned ? 1 : 0) : cur.pinned,
      fields.tags !== undefined ? fields.tags : cur.tags,
      now(), vec, id);
  return getMemory(id);
}

export function deleteMemory(id) { db.prepare('DELETE FROM memory WHERE id=?').run(id); }

export function deleteAllMemories({ scope = null, source_type = null } = {}) {
  if (scope) { db.prepare('DELETE FROM memory WHERE scope=?').run(scope); db.prepare('DELETE FROM memory_suggestions WHERE scope=?').run(scope); }
  else if (source_type) { db.prepare('DELETE FROM memory WHERE source_type=?').run(source_type); db.prepare('DELETE FROM memory_suggestions WHERE source_type=?').run(source_type); }
  else { db.prepare('DELETE FROM memory').run(); db.prepare('DELETE FROM memory_suggestions').run(); db.prepare('DELETE FROM conversation_chunks').run(); }
}

// ---- Fila de revisão: memórias sugeridas pela IA ----
function cleanSuggestionFields(fields = {}) {
  const content = String(fields.content || '').trim();
  const type = ['perfil', 'preferencia', 'projeto', 'fato', 'manual'].includes(fields.type) ? fields.type : 'fato';
  const scope = String(fields.scope || 'global').trim() || 'global';
  const importance = Math.min(5, Math.max(1, Number(fields.importance) || 3));
  const confidence = Math.min(1, Math.max(0, Number(fields.confidence) || 0.7));
  return {
    content,
    type,
    scope,
    importance,
    confidence,
    tags: fields.tags || null,
    source_type: fields.source_type || 'auto',
    source_id: fields.source_id || null
  };
}

export function listMemorySuggestions({ status = 'pending', limit = 100 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM memory_suggestions WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, Number(limit) || 100)
    : db.prepare('SELECT * FROM memory_suggestions ORDER BY created_at DESC LIMIT ?').all(Number(limit) || 100);
  return rows;
}

export function addMemorySuggestion(fields = {}) {
  const s = cleanSuggestionFields(fields);
  if (!s.content) return null;
  if (looksSensitive(s.content)) return null;
  const existing = db.prepare(`SELECT * FROM memory_suggestions
    WHERE status='pending' AND scope=? AND lower(content)=lower(?) LIMIT 1`).get(s.scope, s.content);
  if (existing) return existing;
  const id = nanoid();
  const t = now();
  db.prepare(`INSERT INTO memory_suggestions
    (id, scope, content, type, source_type, source_id, importance, confidence, tags, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`)
    .run(id, s.scope, s.content, s.type, s.source_type, s.source_id, s.importance, s.confidence, s.tags, t, t);
  return db.prepare('SELECT * FROM memory_suggestions WHERE id=?').get(id);
}

export function updateMemorySuggestion(id, fields = {}) {
  const cur = db.prepare('SELECT * FROM memory_suggestions WHERE id=?').get(id);
  if (!cur || cur.status !== 'pending') return null;
  const s = cleanSuggestionFields({ ...cur, ...fields });
  if (!s.content) throw new Error('Conteúdo vazio.');
  if (looksSensitive(s.content)) throw new Error('Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.');
  db.prepare(`UPDATE memory_suggestions SET content=?, type=?, scope=?, importance=?, confidence=?, tags=?, updated_at=? WHERE id=?`)
    .run(s.content, s.type, s.scope, s.importance, s.confidence, s.tags, now(), id);
  return db.prepare('SELECT * FROM memory_suggestions WHERE id=?').get(id);
}

export async function approveMemorySuggestion(id, fields = {}) {
  const cur = fields && Object.keys(fields).length ? updateMemorySuggestion(id, fields) : db.prepare('SELECT * FROM memory_suggestions WHERE id=?').get(id);
  if (!cur || cur.status !== 'pending') return null;
  const mem = await addMemory({
    content: cur.content,
    type: cur.type,
    scope: cur.scope,
    importance: cur.importance,
    confidence: cur.confidence,
    tags: cur.tags,
    source_type: cur.source_type || 'auto',
    source_id: cur.source_id,
    pinned: 0
  });
  db.prepare("UPDATE memory_suggestions SET status='approved', approved_memory_id=?, decided_at=?, updated_at=? WHERE id=?")
    .run(mem.id, now(), now(), id);
  return { suggestion: db.prepare('SELECT * FROM memory_suggestions WHERE id=?').get(id), memory: mem };
}

export function rejectMemorySuggestion(id) {
  const cur = db.prepare('SELECT * FROM memory_suggestions WHERE id=?').get(id);
  if (!cur || cur.status !== 'pending') return null;
  db.prepare("UPDATE memory_suggestions SET status='rejected', decided_at=?, updated_at=? WHERE id=?").run(now(), now(), id);
  return db.prepare('SELECT * FROM memory_suggestions WHERE id=?').get(id);
}

// Lista com filtros (para a interface). query usa busca semântica + texto.
export async function listMemories({ query = '', type = '', scope = '', limit = 300 } = {}) {
  let rows = db.prepare('SELECT * FROM memory ORDER BY pinned DESC, updated_at DESC, created_at DESC').all();
  if (type) rows = rows.filter(r => r.type === type);
  if (scope) rows = rows.filter(r => r.scope === scope);
  if (query.trim()) {
    const qEmb = await embedOne(query, 'query');
    rows = rows.map(r => ({
      ...r,
      _score: qEmb && r.embedding ? cosine(qEmb, r.embedding) : keywordScore(query, `${r.content} ${r.tags || ''}`)
    })).filter(r => r._score > 0.2 || String(r.content).toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b._score - a._score);
  }
  return rows.slice(0, limit).map(({ embedding, ...r }) => r);
}

// ---- Recuperação com ranking (semântica + recência + importância + fixadas) ----
function recencyBoost(iso) {
  const days = Math.max(0, (Date.now() - new Date(iso || 0).getTime()) / 86400000);
  return Math.exp(-days / 90);
}

export async function searchMemories(queryText, { scopes = ['global'], excludeTypes = [], limit = 12, minScore = 0.25 } = {}) {
  const qEmb = await embedOne(queryText, 'query');
  const ph = scopes.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM memory WHERE scope IN (${ph})`).all(...scopes);
  const scored = rows
    .filter(r => !excludeTypes.includes(r.type))
    .map(r => {
      const sim = qEmb && r.embedding ? cosine(qEmb, r.embedding) : keywordScore(queryText, r.content);
      const score = 0.6 * sim + 0.15 * ((r.importance || 3) / 5) + 0.15 * recencyBoost(r.updated_at || r.created_at) + (r.pinned ? 0.15 : 0);
      return { ...r, _sim: sim, _score: score };
    })
    .filter(r => r._sim >= (qEmb ? minScore : 0.15))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
  return scored.map(({ embedding, ...r }) => r);
}

export async function searchChunks(queryText, { excludeConversationId = null, scopes = ['global'], limit = 10, minScore = 0.3 } = {}) {
  const qEmb = await embedOne(queryText, 'query');
  const rows = db.prepare('SELECT * FROM conversation_chunks ORDER BY created_at DESC LIMIT 4000').all();
  const allowed = new Set(scopes);
  const scored = rows
    .filter(r => allowed.has(r.scope || 'global')) // isolamento por cliente
    .filter(r => !excludeConversationId || r.conversation_id !== excludeConversationId)
    .map(r => {
      const sim = qEmb && r.embedding ? cosine(qEmb, r.embedding) : keywordScore(queryText, r.content);
      return { ...r, _sim: sim, _score: 0.8 * sim + 0.2 * recencyBoost(r.created_at) };
    })
    .filter(r => r._sim >= (qEmb ? minScore : 0.25))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
  return scored.map(({ embedding, ...r }) => r);
}

// Dedupe: encontra memória muito parecida (evita salvar o mesmo fato 2x)
export async function findSimilar(content, threshold = 0.88) {
  const qEmb = await embedOne(content, 'query');
  const rows = db.prepare('SELECT id, content, importance, embedding FROM memory').all();
  let best = null;
  for (const r of rows) {
    const sim = qEmb && r.embedding ? cosine(qEmb, r.embedding) : keywordScore(content, r.content);
    if (sim >= threshold && (!best || sim > best.sim)) best = { id: r.id, sim, importance: r.importance };
  }
  return best;
}

// ---- Exportar / Reindexar ----
export function exportAll() {
  const memories = db.prepare('SELECT id, scope, type, content, source_type, source_id, importance, confidence, pinned, tags, created_at, updated_at FROM memory').all();
  const suggestions = db.prepare('SELECT id, scope, type, content, source_type, source_id, importance, confidence, tags, status, created_at, updated_at, decided_at FROM memory_suggestions').all();
  const conversations = db.prepare('SELECT id, title, summary_short, tags, created_at FROM conversations').all();
  const chunks = db.prepare('SELECT COUNT(*) c FROM conversation_chunks').get().c;
  return { exported_at: now(), memories, suggestions, conversations, chunks_indexed: chunks, degraded_mode: embeddingsDegraded() };
}

export async function reindexAll() {
  const mems = db.prepare('SELECT id, content FROM memory').all();
  const chunks = db.prepare('SELECT id, content FROM conversation_chunks').all();
  let done = 0;
  for (let i = 0; i < mems.length; i += 16) {
    const batch = mems.slice(i, i + 16);
    const vecs = await embed(batch.map(m => m.content), 'passage');
    batch.forEach((m, j) => { if (vecs[j]) { db.prepare('UPDATE memory SET embedding=? WHERE id=?').run(vecs[j], m.id); done++; } });
  }
  for (let i = 0; i < chunks.length; i += 16) {
    const batch = chunks.slice(i, i + 16);
    const vecs = await embed(batch.map(m => m.content), 'passage');
    batch.forEach((m, j) => { if (vecs[j]) { db.prepare('UPDATE conversation_chunks SET embedding=? WHERE id=?').run(vecs[j], m.id); done++; } });
  }
  return { reindexed: done, total: mems.length + chunks.length, degraded: embeddingsDegraded() };
}
