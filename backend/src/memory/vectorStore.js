// Busca vetorial no PRÓPRIO PostgreSQL (extensão pgvector), substituindo a
// varredura em JS que carregava todas as memórias/chunks do usuário na RAM do
// Node para calcular cosseno. Com pgvector, a consulta vira um
// `ORDER BY embedding_vec <=> $query LIMIT n` com índice HNSW — escala com o
// banco, não com o processo.
//
// Compatibilidade: a extensão pode não existir na imagem de Postgres em uso
// (ex.: postgres:16-alpine puro). Nesse caso NADA quebra — initVectorStore()
// detecta a ausência e a busca continua no caminho antigo em JS (fallback).
// A coluna BYTEA `embedding` segue sendo a fonte da verdade (é ela que o
// fallback e o reindex usam); `embedding_vec` é uma projeção para o índice.
import { db } from '../db.js';

// Dimensão do modelo padrão (Xenova/multilingual-e5-small). Vetores de outra
// dimensão (modelo trocado via EMBEDDING_MODEL) não entram no índice — a busca
// deles continua pelo fallback em JS até um reindex com o modelo padrão.
export const VECTOR_DIM = 384;

let available = false;
let iterativeScan = false; // pgvector >= 0.8: scan iterativo (recall com filtro)
export function vectorSearchAvailable() { return available; }

// Buffer Float32 (como sai de embeddings.js) -> literal aceito pelo pgvector.
// Devolve null para vetor ausente ou de dimensão incompatível com o índice —
// com um aviso ruidoso (uma vez) para a degradação não ser silenciosa.
let warnedDim = false;
export function toVectorLiteral(buf) {
  if (!buf) return null;
  if (buf.byteLength !== VECTOR_DIM * 4) {
    if (!warnedDim && available) {
      warnedDim = true;
      console.warn(`[memória] AVISO: embedding de ${buf.byteLength / 4} dimensões ≠ coluna vector(${VECTOR_DIM}) — o índice pgvector fica INATIVO para esses vetores e a busca cai no modo JS. Causa comum: EMBEDDING_MODEL trocado. Volte ao modelo padrão ou reindexe após ajustar a dimensão da coluna.`);
    }
    return null;
  }
  const f = new Float32Array(buf.buffer, buf.byteOffset, VECTOR_DIM);
  return `[${Array.from(f).join(',')}]`;
}

// Espelha o embedding recém-gravado na coluna vetorial (no-op sem pgvector).
export async function saveEmbeddingVec(table, id, buf) {
  if (!available) return;
  if (table !== 'memory' && table !== 'conversation_chunks') throw new Error(`tabela inesperada: ${table}`);
  try {
    await db.prepare(`UPDATE ${table} SET embedding_vec=?::vector WHERE id=?`).run(toVectorLiteral(buf), id);
  } catch (e) { console.error('[memória] falha ao gravar vetor pgvector:', e.message); }
}

// KNN no banco, compartilhado por searchMemories/searchChunks/findSimilar.
// `where` NÃO deve incluir o filtro de embedding_vec (o helper põe). Roda numa
// transação para o SET LOCAL não vazar para outras conexões do pool:
//   * ef_search alto o bastante para o LIMIT pedido (o padrão 40 truncava os
//     candidatos ANTES do filtro de user_id/scope — usuário com fatia pequena
//     da tabela recebia 1-2 resultados);
//   * scan iterativo (pgvector >= 0.8): continua varrendo o índice até achar
//     LIMIT linhas que passem no filtro, em vez de parar em ef_search tuplas.
export async function knnCandidates({ table, where, params = [], qLit, limit }) {
  const efSearch = Math.min(1000, Math.max(100, limit * 2));
  const run = db.transaction(async () => {
    await db.exec(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    if (iterativeScan) await db.exec("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
    return db.prepare(
      `SELECT *, (1 - (embedding_vec <=> ?::vector)) AS _sim FROM ${table}
       WHERE ${where ? `${where} AND ` : ''}embedding_vec IS NOT NULL
       ORDER BY embedding_vec <=> ?::vector LIMIT ?`)
      .all(qLit, ...params, qLit, limit);
  });
  return run();
}

// Chamado no boot, depois das migrations. Habilita a extensão e cria as
// colunas (tudo idempotente — também cobre o caso de a imagem do Postgres
// ganhar pgvector só depois do primeiro deploy). Índices e backfill rodam em
// SEGUNDO PLANO: numa base restaurada sem índice, o CREATE INDEX HNSW pode
// levar minutos e não deve segurar o app.listen (as buscas funcionam sem o
// índice enquanto isso — só ficam mais lentas).
export async function initVectorStore() {
  try { await db.exec('CREATE EXTENSION IF NOT EXISTS vector'); } catch { /* sem a extensão ou sem permissão */ }
  try {
    if (!await db.prepare("SELECT 1 FROM pg_extension WHERE extname='vector'").get()) {
      console.log('[memória] pgvector indisponível — busca semântica continua em JS (use a imagem pgvector/pgvector para escalar).');
      return false;
    }
    await db.exec(`ALTER TABLE memory ADD COLUMN IF NOT EXISTS embedding_vec vector(${VECTOR_DIM})`);
    await db.exec(`ALTER TABLE conversation_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector(${VECTOR_DIM})`);
    // Scan iterativo existe a partir do pgvector 0.8 (a tag pgvector/pgvector:pg16
    // é rolante; deploys antigos podem ter 0.6/0.7 — detecta em runtime).
    iterativeScan = (await db.prepare("SELECT current_setting('hnsw.iterative_scan', true) AS v").get())?.v != null;
    available = true;
    console.log(`[memória] pgvector ativo — busca semântica roda no banco${iterativeScan ? ' (scan iterativo)' : ''}.`);
    (async () => {
      // HNSW: bom recall sem etapa de treino (dispensa o "ANALYZE + lists" do ivfflat).
      await db.exec('CREATE INDEX IF NOT EXISTS idx_memory_embedding_vec ON memory USING hnsw (embedding_vec vector_cosine_ops)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_embedding_vec ON conversation_chunks USING hnsw (embedding_vec vector_cosine_ops)');
      await backfillVectors();
    })().catch(e => console.error('[memória] índice/backfill pgvector falhou:', e.message));
    return true;
  } catch (e) {
    console.error('[memória] pgvector não pôde ser inicializado (busca segue em JS):', e.message);
    available = false;
    return false;
  }
}

// Preenche embedding_vec a partir do BYTEA em lotes, com paginação por id para
// não reprocessar linhas de dimensão incompatível.
export async function backfillVectors() {
  if (!available) return { updated: 0 };
  let updated = 0;
  for (const table of ['memory', 'conversation_chunks']) {
    let lastId = '';
    for (;;) {
      const rows = await db.prepare(
        `SELECT id, embedding FROM ${table}
         WHERE embedding IS NOT NULL AND embedding_vec IS NULL AND id > ?
         ORDER BY id LIMIT 200`).all(lastId);
      if (!rows.length) break;
      for (const r of rows) {
        const lit = toVectorLiteral(r.embedding);
        if (lit) { await db.prepare(`UPDATE ${table} SET embedding_vec=?::vector WHERE id=?`).run(lit, r.id); updated++; }
        lastId = r.id;
      }
    }
  }
  if (updated) console.log(`[memória] backfill pgvector: ${updated} vetor(es) indexado(s).`);
  return { updated };
}
