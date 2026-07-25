import { db, now } from '../db.js';
import { nanoid } from 'nanoid';
import { embed, embedOne, cosine, keywordScore, embeddingsDegraded, embeddingModelId, isEmbeddingIdentityCompatible } from './embeddings.js';
import { vectorSearchAvailable, toVectorLiteral, saveEmbeddingVec, knnCandidates } from './vectorStore.js';

// Se o modelo de embeddings mudou desde a última execução, os vetores antigos
// ficam incompatíveis (a busca semântica silenciosamente vira busca por
// palavras). Detecta a troca e reindexa em segundo plano, uma vez.
export async function maybeReindexOnModelChange() {
  try {
    const prev = (await db.prepare("SELECT value FROM settings WHERE key='embedding_model'").get())?.value;
    // A comparação passa por `isEmbeddingIdentityCompatible` em vez de `!==`
    // direto: a identidade agora inclui a quantização, e o valor gravado pelas
    // versões anteriores não tinha sufixo. Sem esta ponte, toda instalação
    // existente reindexaria a memória inteira só pela mudança de formato do
    // rótulo — os vetores em si são idênticos (medido na migração).
    if (prev && !isEmbeddingIdentityCompatible(prev)) {
      console.log(`[memória] modelo de embeddings mudou (${prev} → ${embeddingModelId}); reindexando em segundo plano...`);
      reindexAll().then(() => console.log('[memória] reindexação concluída.')).catch(e => console.error('[memória] reindex falhou:', e.message));
    }
    await db.prepare("INSERT INTO settings (key,value) VALUES ('embedding_model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(embeddingModelId);
  } catch (e) { console.error('[memória] verificação de modelo falhou:', e.message); }
}

// ---- Configurações da memória (tabela settings) ----
export const DEFAULT_SETTINGS = {
  memory_enabled: 1,          // memória ligada/desligada
  auto_memory: 1,             // extração automática de fatos
  review_auto_memory: 1,      // fatos aprendidos entram em fila para revisão
  economy_mode: 1,            // economia de tokens: limita contexto/histórico e reduz chamadas extras
  context_target_tokens: 60000, // alvo do Context Builder (suba p/ modelos de 1M)
  max_memories: 12,           // memórias recuperadas por resposta
  max_chunks: 10,             // trechos de conversas antigas por resposta
  importance_threshold: 2,    // importância mínima p/ salvar memória automática
  // Política de rede do sandbox (container de execução por conversa). NÃO afeta
  // os modelos de IA — as chamadas aos provedores saem do backend, não do
  // container. Controla só o que o CÓDIGO executado dentro da conversa alcança.
  // 0 = automático (abre quando o pedido pede claramente; padrão seguro)
  // 1 = sempre ligada  2 = sempre desligada
  sandbox_network_policy: 0
};

// Teto de contexto no modo economia (o Context Builder já reduz memórias,
// trechos e histórico proporcionalmente quando o orçamento é pequeno).
export const ECONOMY_CONTEXT_TOKENS = 8000;

// Cache em memória das configurações. Com o Postgres (async), ler settings a
// cada chamada tornaria getSettings() assíncrono e isso quebraria os usos como
// valor padrão de parâmetro (ex.: contextBuilder). Mantemos um cache carregado
// no boot (loadSettings) e atualizado a cada setSettings — assim getSettings()
// continua SÍNCRONO e o comportamento do app não muda.
let settingsCache = { ...DEFAULT_SETTINGS };

export async function loadSettings() {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const out = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in out) out[r.key] = Number(r.value);
    settingsCache = out;
  } catch (e) { console.error('[memória] loadSettings falhou:', e.message); }
  return { ...settingsCache };
}

export function getSettings() {
  return { ...settingsCache };
}

export async function setSettings(partial) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(partial || {})) {
    if (k in DEFAULT_SETTINGS && v !== undefined && v !== null && !Number.isNaN(Number(v))) await stmt.run(k, String(Number(v)));
  }
  return loadSettings();
}

// ---- Piso de similaridade da busca ----
// O multilingual-e5-small NÃO usa a faixa 0..1: dois textos quaisquer no mesmo
// idioma ficam em ~0,74–0,90. Os pisos antigos (0,25 e 0,30) estavam MUITO
// abaixo desse chão, então nenhum candidato era descartado — a busca devolvia
// sempre o `limit` cheio, e a interface mostrava "85% de similaridade" para
// conversas sem relação nenhuma com o pedido. 0,80 corta o ruído de fundo e
// deixa passar o que de fato se parece. (A pontuação por palavras do modo
// degradado tem escala própria e mantém os pisos antigos.)
export const EMBEDDING_MIN_SIM = Number(process.env.MEMORY_MIN_SIM || 0.80);
const KEYWORD_MIN_SIM_MEMORY = 0.15;
const KEYWORD_MIN_SIM_CHUNK = 0.25;

// Pontua uma linha e registra de ONDE veio a similaridade: sem isso a
// calibração do e5 seria aplicada também à contagem de palavras, que já nasce
// em 0..1 — e aí o modo degradado ficaria mudo.
function simFor(row, qEmb, queryText) {
  if (qEmb && row.embedding) return { ...row, _sim: cosine(qEmb, row.embedding), _simKind: 'embedding' };
  return { ...row, _sim: keywordScore(queryText, row.content), _simKind: 'keyword' };
}

function simFloor(row, embeddingFloor, keywordFloor) {
  return row._simKind === 'embedding' ? embeddingFloor : keywordFloor;
}

// ---- Proteção: nunca salvar segredos automaticamente ----
const SENSITIVE = /(sk-[a-z0-9-]{8,}|api[_-]?key|senha|password|token\s*[:=]|bearer\s+[a-z0-9._-]{10,}|-----BEGIN)/i;
export function looksSensitive(text) { return SENSITIVE.test(String(text || '')); }

// ---- CRUD de memórias ----
export async function addMemory(userId, { content, type = 'manual', scope = 'global', importance = 3, confidence = 1, tags = null, source_type = 'manual', source_id = null, pinned = 0 }) {
  content = String(content || '').trim();
  if (!content) throw new Error('Conteúdo vazio.');
  if (looksSensitive(content)) throw new Error('Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.');
  const [vec] = await embed([content], 'passage');
  const id = nanoid();
  const t = now();
  await db.prepare(`INSERT INTO memory (id, user_id, scope, content, type, source_type, source_id, importance, confidence, pinned, tags, created_at, updated_at, embedding)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, scope, content, type, source_type, source_id, importance, confidence, pinned ? 1 : 0, tags, t, t, vec);
  await saveEmbeddingVec('memory', id, vec);
  return getMemory(userId, id);
}

export async function getMemory(userId, id) {
  const m = await db.prepare('SELECT * FROM memory WHERE id=? AND user_id=?').get(id, userId);
  if (m) delete m.embedding;
  return m;
}

export async function updateMemory(userId, id, fields = {}) {
  const cur = await db.prepare('SELECT * FROM memory WHERE id=? AND user_id=?').get(id, userId);
  if (!cur) return null;
  const content = fields.content !== undefined ? String(fields.content).trim() : cur.content;
  if (fields.content !== undefined && looksSensitive(content)) throw new Error('Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.');
  const contentChanged = fields.content !== undefined && content !== cur.content;
  const vec = contentChanged ? await embedOne(content, 'passage') : cur.embedding;
  await db.prepare(`UPDATE memory SET content=?, type=?, scope=?, importance=?, pinned=?, tags=?, updated_at=?, embedding=? WHERE id=? AND user_id=?`)
    .run(content,
      fields.type !== undefined ? fields.type : cur.type,
      fields.scope !== undefined ? fields.scope : cur.scope,
      fields.importance !== undefined ? Number(fields.importance) : cur.importance,
      fields.pinned !== undefined ? (fields.pinned ? 1 : 0) : cur.pinned,
      fields.tags !== undefined ? fields.tags : cur.tags,
      now(), vec, id, userId);
  // Só reescreve a projeção vetorial quando o embedding mudou de fato — editar
  // pin/importância/tags não precisa tocar no índice HNSW (manutenção cara).
  if (contentChanged) await saveEmbeddingVec('memory', id, vec);
  return getMemory(userId, id);
}

export async function deleteMemory(userId, id) { await db.prepare('DELETE FROM memory WHERE id=? AND user_id=?').run(id, userId); }

export async function deleteAllMemories(userId, { scope = null, source_type = null } = {}) {
  if (scope) { await db.prepare('DELETE FROM memory WHERE scope=? AND user_id=?').run(scope, userId); await db.prepare('DELETE FROM memory_suggestions WHERE scope=? AND user_id=?').run(scope, userId); await db.prepare('DELETE FROM conversation_chunks WHERE scope=? AND user_id=?').run(scope, userId); }
  else if (source_type) { await db.prepare('DELETE FROM memory WHERE source_type=? AND user_id=?').run(source_type, userId); await db.prepare('DELETE FROM memory_suggestions WHERE source_type=? AND user_id=?').run(source_type, userId); }
  else { await db.prepare('DELETE FROM memory WHERE user_id=?').run(userId); await db.prepare('DELETE FROM memory_suggestions WHERE user_id=?').run(userId); await db.prepare('DELETE FROM conversation_chunks WHERE user_id=?').run(userId); }
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

export async function listMemorySuggestions(userId, { status = 'pending', limit = 100 } = {}) {
  const rows = status
    ? await db.prepare('SELECT * FROM memory_suggestions WHERE status=? AND user_id=? ORDER BY created_at DESC LIMIT ?').all(status, userId, Number(limit) || 100)
    : await db.prepare('SELECT * FROM memory_suggestions WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(userId, Number(limit) || 100);
  return rows;
}

export async function addMemorySuggestion(userId, fields = {}) {
  const s = cleanSuggestionFields(fields);
  if (!s.content) return null;
  if (looksSensitive(s.content)) return null;
  const existing = await db.prepare(`SELECT * FROM memory_suggestions
    WHERE status='pending' AND user_id=? AND scope=? AND lower(content)=lower(?) LIMIT 1`).get(userId, s.scope, s.content);
  if (existing) return existing;
  const id = nanoid();
  const t = now();
  await db.prepare(`INSERT INTO memory_suggestions
    (id, user_id, scope, content, type, source_type, source_id, importance, confidence, tags, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
    .run(id, userId, s.scope, s.content, s.type, s.source_type, s.source_id, s.importance, s.confidence, s.tags, t, t);
  return db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?').get(id, userId);
}

export async function updateMemorySuggestion(userId, id, fields = {}) {
  const cur = await db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?').get(id, userId);
  if (!cur || cur.status !== 'pending') return null;
  const s = cleanSuggestionFields({ ...cur, ...fields });
  if (!s.content) throw new Error('Conteúdo vazio.');
  if (looksSensitive(s.content)) throw new Error('Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.');
  await db.prepare(`UPDATE memory_suggestions SET content=?, type=?, scope=?, importance=?, confidence=?, tags=?, updated_at=? WHERE id=? AND user_id=?`)
    .run(s.content, s.type, s.scope, s.importance, s.confidence, s.tags, now(), id, userId);
  return db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?').get(id, userId);
}

export async function approveMemorySuggestion(userId, id, fields = {}) {
  const cur = fields && Object.keys(fields).length ? await updateMemorySuggestion(userId, id, fields) : await db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?').get(id, userId);
  if (!cur || cur.status !== 'pending') return null;
  const mem = await addMemory(userId, {
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
  await db.prepare("UPDATE memory_suggestions SET status='approved', approved_memory_id=?, decided_at=?, updated_at=? WHERE id=? AND user_id=?")
    .run(mem.id, now(), now(), id, userId);
  return { suggestion: await db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?').get(id, userId), memory: mem };
}

export async function rejectMemorySuggestion(userId, id) {
  const cur = await db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?').get(id, userId);
  if (!cur || cur.status !== 'pending') return null;
  await db.prepare("UPDATE memory_suggestions SET status='rejected', decided_at=?, updated_at=? WHERE id=? AND user_id=?").run(now(), now(), id, userId);
  return db.prepare('SELECT * FROM memory_suggestions WHERE id=? AND user_id=?').get(id, userId);
}

// Lista com filtros (para a interface). query usa busca semântica + texto.
export async function listMemories(userId, { query = '', type = '', scope = '', limit = 300 } = {}) {
  let rows = await db.prepare('SELECT * FROM memory WHERE user_id=? ORDER BY pinned DESC, updated_at DESC, created_at DESC').all(userId);
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

export async function searchMemories(userId, queryText, { scopes = ['global'], excludeTypes = [], limit = 12, minScore = EMBEDDING_MIN_SIM } = {}) {
  const qEmb = await embedOne(queryText, 'query');
  const qLit = toVectorLiteral(qEmb);
  const ph = scopes.map(() => '?').join(',');
  let rows = null;
  if (vectorSearchAvailable() && qLit) {
    // pgvector: o índice HNSW devolve só os melhores candidatos, com folga
    // para o re-ranking (importância/recência/fixadas) feito logo abaixo.
    const fetchN = Math.min(200, Math.max(limit * 5, 40));
    const vecRows = await knnCandidates({ table: 'memory', where: `scope IN (${ph}) AND user_id=?`, params: [...scopes, userId], qLit, limit: fetchN });
    if (vecRows.length >= limit) {
      // Linhas SEM vetor (período de embeddings degradados / backfill pendente)
      // não estão no índice: varre só esse resíduo em JS e junta — sem isto
      // elas ficariam invisíveis à busca enquanto o pgvector estivesse ativo.
      const resid = await db.prepare(`SELECT * FROM memory WHERE scope IN (${ph}) AND user_id=? AND embedding_vec IS NULL LIMIT 500`).all(...scopes, userId);
      rows = vecRows.map(r => ({ ...r, _simKind: 'embedding' }))
        .concat(resid.map(r => simFor(r, qEmb, queryText)));
    }
    // vecRows < limit: usuário com poucas memórias OU truncamento pós-filtro do
    // HNSW (pgvector < 0.8, sem scan iterativo) — cai na varredura completa, que
    // nesses casos é barata e garante o mesmo resultado do caminho antigo.
  }
  if (!rows) {
    // Fallback (sem pgvector, embeddings degradados ou poucos candidatos).
    rows = (await db.prepare(`SELECT * FROM memory WHERE scope IN (${ph}) AND user_id=?`).all(...scopes, userId))
      .map(r => simFor(r, qEmb, queryText));
  }
  const scored = rows
    .filter(r => !excludeTypes.includes(r.type))
    .map(r => ({ ...r, _score: 0.6 * r._sim + 0.15 * ((r.importance || 3) / 5) + 0.15 * recencyBoost(r.updated_at || r.created_at) + (r.pinned ? 0.15 : 0) }))
    .filter(r => r._sim >= simFloor(r, minScore, KEYWORD_MIN_SIM_MEMORY))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
  return scored.map(({ embedding, embedding_vec, ...r }) => r);
}

export async function searchChunks(userId, queryText, { excludeConversationId = null, scopes = ['global'], limit = 10, minScore = EMBEDDING_MIN_SIM } = {}) {
  const qEmb = await embedOne(queryText, 'query');
  const qLit = toVectorLiteral(qEmb);
  let scored = null;
  if (vectorSearchAvailable() && qLit) {
    // pgvector: filtro de escopo (isolamento por cliente) e de conversa já na
    // query — nada de carregar 4000 chunks na RAM do Node.
    const ph = scopes.map(() => '?').join(',');
    const fetchN = Math.min(200, Math.max(limit * 5, 40));
    const excl = excludeConversationId ? ' AND (conversation_id IS NULL OR conversation_id <> ?)' : '';
    const where = `user_id=? AND COALESCE(scope,'global') IN (${ph})${excl}`;
    const params = [userId, ...scopes];
    if (excludeConversationId) params.push(excludeConversationId);
    const vecRows = await knnCandidates({ table: 'conversation_chunks', where, params, qLit, limit: fetchN });
    if (vecRows.length >= limit) {
      // Resíduo sem vetor (degradação/backfill pendente): pontua em JS e junta.
      const resid = await db.prepare(`SELECT * FROM conversation_chunks WHERE ${where} AND embedding_vec IS NULL LIMIT 500`).all(...params);
      scored = vecRows.map(r => ({ ...r, _simKind: 'embedding' }))
        .concat(resid.map(r => simFor(r, qEmb, queryText)))
        .map(r => ({ ...r, _score: 0.8 * r._sim + 0.2 * recencyBoost(r.created_at) }));
    }
    // vecRows < limit → varredura completa abaixo (mesma razão de searchMemories).
  }
  if (!scored) {
    const rows = await db.prepare('SELECT * FROM conversation_chunks WHERE user_id=? ORDER BY created_at DESC LIMIT 4000').all(userId);
    const allowed = new Set(scopes);
    scored = rows
      .filter(r => allowed.has(r.scope || 'global')) // isolamento por cliente
      .filter(r => !excludeConversationId || r.conversation_id !== excludeConversationId)
      .map(r => {
        const scoredRow = simFor(r, qEmb, queryText);
        return { ...scoredRow, _score: 0.8 * scoredRow._sim + 0.2 * recencyBoost(r.created_at) };
      });
  }
  return scored
    .filter(r => r._sim >= simFloor(r, minScore, KEYWORD_MIN_SIM_CHUNK))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ embedding, embedding_vec, ...r }) => r);
}

// Dedupe: encontra memória muito parecida (evita salvar o mesmo fato 2x).
// Filtra pelo MESMO escopo — senão um fato do cliente A some por já existir
// parecido no cliente B (vazamento entre clientes). Usa prefixo 'passage'
// para comparar passagem-com-passagem (o mesmo usado ao gravar).
export async function findSimilar(userId, content, threshold = 0.88, scope = null) {
  const qEmb = await embedOne(content, 'passage');
  const qLit = toVectorLiteral(qEmb);
  if (vectorSearchAvailable() && qLit) {
    const where = scope ? 'scope=? AND user_id=?' : 'user_id=?';
    const params = scope ? [scope, userId] : [userId];
    const row = (await knnCandidates({ table: 'memory', where, params, qLit, limit: 1 }))[0];
    let best = row && row._sim >= threshold ? { id: row.id, sim: row._sim, importance: row.importance } : null;
    // Resíduo sem vetor (degradação/backfill pendente): sem esta passada, o
    // dedupe não enxergaria essas memórias e o mesmo fato seria salvo de novo.
    const resid = await db.prepare(`SELECT id, content, importance, embedding FROM memory WHERE ${where} AND embedding_vec IS NULL LIMIT 500`).all(...params);
    for (const r of resid) {
      const sim = qEmb && r.embedding ? cosine(qEmb, r.embedding) : keywordScore(content, r.content);
      if (sim >= threshold && (!best || sim > best.sim)) best = { id: r.id, sim, importance: r.importance };
    }
    return best;
  }
  const rows = scope
    ? await db.prepare('SELECT id, content, importance, embedding FROM memory WHERE scope=? AND user_id=?').all(scope, userId)
    : await db.prepare('SELECT id, content, importance, embedding FROM memory WHERE user_id=?').all(userId);
  let best = null;
  for (const r of rows) {
    const sim = qEmb && r.embedding ? cosine(qEmb, r.embedding) : keywordScore(content, r.content);
    if (sim >= threshold && (!best || sim > best.sim)) best = { id: r.id, sim, importance: r.importance };
  }
  return best;
}

// ---- Exportar / Reindexar ----
export async function exportAll(userId) {
  const memories = await db.prepare('SELECT id, scope, type, content, source_type, source_id, importance, confidence, pinned, tags, created_at, updated_at FROM memory WHERE user_id=?').all(userId);
  const suggestions = await db.prepare('SELECT id, scope, type, content, source_type, source_id, importance, confidence, tags, status, created_at, updated_at, decided_at FROM memory_suggestions WHERE user_id=?').all(userId);
  const conversations = await db.prepare('SELECT id, title, summary_short, tags, created_at FROM conversations WHERE user_id=?').all(userId);
  const chunks = Number((await db.prepare('SELECT COUNT(*) c FROM conversation_chunks WHERE user_id=?').get(userId)).c);
  return { exported_at: now(), memories, suggestions, conversations, chunks_indexed: chunks, degraded_mode: embeddingsDegraded() };
}

export async function reindexAll(userId = null) {
  // Sem userId (troca global de modelo de embeddings): reindexa TODOS os
  // usuários. Antes, o `WHERE user_id=?` com undefined→null não casava linha
  // nenhuma e o reindex de troca de modelo "concluía" sem regravar nada.
  if (userId == null) {
    const users = await db.prepare(
      `SELECT DISTINCT user_id FROM (
         SELECT user_id FROM memory UNION SELECT user_id FROM conversation_chunks
       ) u WHERE user_id IS NOT NULL`).all();
    let reindexed = 0, total = 0;
    for (const u of users) {
      const r = await reindexAll(u.user_id);
      reindexed += r.reindexed; total += r.total;
    }
    return { reindexed, total, degraded: embeddingsDegraded() };
  }
  const mems = await db.prepare('SELECT id, content FROM memory WHERE user_id=?').all(userId);
  const chunks = await db.prepare('SELECT id, content FROM conversation_chunks WHERE user_id=?').all(userId);
  let done = 0;
  for (let i = 0; i < mems.length; i += 16) {
    const batch = mems.slice(i, i + 16);
    const vecs = await embed(batch.map(m => m.content), 'passage');
    for (let j = 0; j < batch.length; j++) { if (vecs[j]) { await db.prepare('UPDATE memory SET embedding=? WHERE id=? AND user_id=?').run(vecs[j], batch[j].id, userId); await saveEmbeddingVec('memory', batch[j].id, vecs[j]); done++; } }
  }
  for (let i = 0; i < chunks.length; i += 16) {
    const batch = chunks.slice(i, i + 16);
    const vecs = await embed(batch.map(m => m.content), 'passage');
    for (let j = 0; j < batch.length; j++) { if (vecs[j]) { await db.prepare('UPDATE conversation_chunks SET embedding=? WHERE id=? AND user_id=?').run(vecs[j], batch[j].id, userId); await saveEmbeddingVec('conversation_chunks', batch[j].id, vecs[j]); done++; } }
  }
  return { reindexed: done, total: mems.length + chunks.length, degraded: embeddingsDegraded() };
}
