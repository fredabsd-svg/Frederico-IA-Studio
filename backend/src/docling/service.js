// Orquestração do processamento documental. É aqui que a "camada central" vive:
//   hash -> cache (document_processings) -> docling-service -> JSON completo +
//   Markdown otimizado + chunks -> persistência -> métricas de tokens.
// Idempotente por (user_id, hash, config_version): o MESMO arquivo com a MESMA
// configuração nunca é reprocessado — reutilizado por chat, assistentes, modo
// dev e multi-modelo. Qualquer falha no serviço cai no fallback silencioso
// (o app segue com o comportamento atual, sem regressão).
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { isDoclingEnabled, isDoclingSupported, configVersion } from './config.js';
import { resolvedOptions } from './adminConfig.js';
import { runDocling } from './runner.js';
import { optimizeMarkdown } from './markdown.js';
import { chunkMarkdown } from './chunker.js';
import { estimateTokens, savings } from './tokens.js';
import { summarizeTables } from './tables.js';
import { chunkEmbedText } from './semantic.js';
import { embed, embeddingsDegraded } from '../memory/embeddings.js';

function cacheRoot() {
  return process.env.DOCLING_CACHE_ROOT || path.resolve(process.env.WORKSPACE_ROOT || './workspaces', '..', 'docling-cache');
}
function artifactDir(userId, hash, cfg) {
  return path.join(cacheRoot(), String(userId), `${hash}_${cfg}`);
}

function serialize(row) {
  if (!row) return null;
  let stats = null, warnings = null;
  try { stats = row.stats ? JSON.parse(row.stats) : null; } catch {}
  try { warnings = row.warnings ? JSON.parse(row.warnings) : null; } catch {}
  return {
    id: row.id, hash: row.hash, mime: row.mime, filename: row.filename, fileId: row.file_id,
    status: row.status, engine: row.engine, configVersion: row.config_version,
    ocrUsed: !!row.ocr_used, pageCount: row.page_count, tableCount: row.table_count,
    tokenOriginal: row.token_original, tokenOptimized: row.token_optimized,
    stats, warnings, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function getProcessingByHash(userId, hash, cfg) {
  return db.prepare('SELECT * FROM document_processings WHERE user_id=? AND hash=? AND config_version=?').get(userId, hash, cfg);
}
export async function getProcessingById(userId, id) {
  return serialize(await db.prepare('SELECT * FROM document_processings WHERE id=? AND user_id=?').get(id, userId));
}
export async function listProcessingsForConversation(userId, conversationId) {
  return (await db.prepare('SELECT * FROM document_processings WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC').all(userId, conversationId)).map(serialize);
}

// Lê os artefatos persistidos (Markdown otimizado, chunks, JSON completo).
export function readArtifacts(userId, hash, cfg) {
  const dir = artifactDir(userId, hash, cfg);
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  const md = read('optimized.md');
  let chunks = null; try { const c = read('chunks.json'); chunks = c ? JSON.parse(c) : null; } catch {}
  // Vetores dos chunks (base64 → Buffer Float32), alinhados a chunks. null quando
  // não houver busca semântica para este documento.
  let embeddings = null;
  try {
    const e = read('embeddings.json');
    if (e) embeddings = JSON.parse(e).map(b => (b ? Buffer.from(b, 'base64') : null));
  } catch {}
  // Figuras/gráficos: metadados + caminho ABSOLUTO do PNG (para anexar a um
  // modelo com visão). `file` vem relativo no JSON e é resolvido aqui.
  let pictures = null;
  try {
    const p = read('pictures.json');
    if (p) pictures = JSON.parse(p).map(pic => ({ ...pic, file: pic.file ? path.join(dir, pic.file) : null }));
  } catch {}
  return { markdown: md, chunks, embeddings, pictures, jsonPath: path.join(dir, 'document.json') };
}

async function upsertRow(fields) {
  const t = now();
  const existing = await getProcessingByHash(fields.user_id, fields.hash, fields.config_version);
  if (existing) {
    await db.prepare(
      `UPDATE document_processings SET conversation_id=?, file_id=?, mime=?, filename=?, engine=?, status=?,
        ocr_used=?, page_count=?, table_count=?, json_path=?, md_path=?, chunks_path=?, stats=?,
        token_original=?, token_optimized=?, warnings=?, error=?, updated_at=? WHERE id=?`
    ).run(
      fields.conversation_id, fields.file_id, fields.mime, fields.filename, fields.engine, fields.status,
      fields.ocr_used ? 1 : 0, fields.page_count, fields.table_count, fields.json_path, fields.md_path,
      fields.chunks_path, fields.stats, fields.token_original, fields.token_optimized, fields.warnings,
      fields.error, t, existing.id,
    );
    return existing.id;
  }
  const id = fields.id || nanoid();
  await db.prepare(
    `INSERT INTO document_processings
     (id,user_id,conversation_id,file_id,hash,mime,filename,config_version,engine,status,ocr_used,page_count,table_count,json_path,md_path,chunks_path,stats,token_original,token_optimized,warnings,error,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, fields.user_id, fields.conversation_id, fields.file_id, fields.hash, fields.mime, fields.filename,
    fields.config_version, fields.engine, fields.status, fields.ocr_used ? 1 : 0, fields.page_count,
    fields.table_count, fields.json_path, fields.md_path, fields.chunks_path, fields.stats,
    fields.token_original, fields.token_optimized, fields.warnings, fields.error, t, t,
  );
  return id;
}

async function setStatus(userId, hash, cfg, status, extra = {}) {
  await db.prepare('UPDATE document_processings SET status=?, stats=COALESCE(?,stats), updated_at=? WHERE user_id=? AND hash=? AND config_version=?')
    .run(status, extra.stats ? JSON.stringify(extra.stats) : null, now(), userId, hash, cfg);
}

// Entry point. Processa (ou reaproveita o cache de) um arquivo já salvo em disco.
// Retorna a linha serializada. NUNCA lança para o chamador: em erro, marca a
// linha como 'failed' e devolve — o fluxo do app continua no fallback.
export async function processFile({ userId, conversationId, fileId, filePath, filename, mime, hash, options, signal, onProgress, force = false }) {
  if (!isDoclingEnabled()) return null;
  if (!isDoclingSupported(filename || filePath)) return null;
  // Opções efetivas: ambiente + overrides do admin + o que veio na chamada.
  const opts = { ...(await resolvedOptions()), ...(options || {}) };
  const cfg = configVersion(opts);

  // Cache: já concluído com esta config? Reutiliza (sem reprocessar).
  // `force` (botão Reprocessar) ignora o cache — sem isto, reprocessar com a
  // MESMA config era um no-op silencioso (o early-return devolvia o cacheado).
  const cached = await getProcessingByHash(userId, hash, cfg);
  if (!force && cached && ['done', 'done_warnings', 'partial'].includes(cached.status)) {
    const arts = readArtifacts(userId, hash, cfg);
    if (arts.markdown) {
      // Só vincula a esta conversa (rastreabilidade), sem reprocessar.
      if (conversationId && cached.conversation_id !== conversationId) {
        await db.prepare('UPDATE document_processings SET conversation_id=?, file_id=COALESCE(?,file_id), updated_at=? WHERE id=?')
          .run(conversationId, fileId, now(), cached.id);
      }
      return serialize(await db.prepare('SELECT * FROM document_processings WHERE id=?').get(cached.id));
    }
  }

  // Marca 'processing' (a UI mostra o andamento).
  await upsertRow({ user_id: userId, conversation_id: conversationId, file_id: fileId, hash, mime, filename,
    config_version: cfg, engine: 'docling', status: 'processing' });

  try {
    const result = await runDocling(filePath, {
      hash, mime, filename, options: opts, timeoutMs: opts.timeoutMs, signal,
      onProgress: (p) => { onProgress?.(p); },
    });
    // result: { status, markdown, docling_json, ocr_used, page_count, table_count, warnings, timing_ms }
    const rawMarkdown = String(result.markdown || '');
    if (!rawMarkdown.trim()) throw new Error('docling-service não retornou conteúdo.');

    const { markdown, report } = optimizeMarkdown(rawMarkdown);
    const chunks = chunkMarkdown(markdown, { maxChunkTokens: opts.maxChunkTokens, documentId: hash.slice(0, 12) });

    const tokenOriginal = estimateTokens(rawMarkdown);
    const tokenOptimized = estimateTokens(markdown);
    const econ = savings(tokenOriginal, tokenOptimized);

    // Persiste os artefatos (JSON completo = fonte da verdade; MD + chunks = IA).
    const dir = artifactDir(userId, hash, cfg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'document.json'), JSON.stringify(result.docling_json ?? {}), 'utf8');
    fs.writeFileSync(path.join(dir, 'optimized.md'), markdown, 'utf8');
    fs.writeFileSync(path.join(dir, 'chunks.json'), JSON.stringify(chunks), 'utf8');

    // Pré-computa os vetores dos chunks (busca semântica) — melhor esforço:
    // se os embeddings estiverem indisponíveis, o context.js cai na seleção por
    // palavras. Fazer isto AGORA (no processamento) evita reembedar a cada
    // pergunta e é o que permite todos os modelos reusarem a mesma seleção.
    let semanticReady = false;
    try {
      if (!embeddingsDegraded() && chunks.length) {
        const vecs = await embed(chunks.map(chunkEmbedText), 'passage');
        if (vecs.some(Boolean)) {
          const b64 = vecs.map(v => (v ? Buffer.from(v).toString('base64') : null));
          fs.writeFileSync(path.join(dir, 'embeddings.json'), JSON.stringify(b64), 'utf8');
          semanticReady = true;
        }
      }
    } catch (e) { console.error('[docling] embeddings dos chunks falharam:', e.message); }

    // Persiste as figuras/gráficos extraídos (PNG + metadados) para um modelo
    // com visão analisar depois. As imagens NUNCA são descartadas em silêncio.
    let pictureMeta = [];
    try {
      const pics = Array.isArray(result.pictures) ? result.pictures : [];
      if (pics.length) {
        const pdir = path.join(dir, 'pictures');
        fs.mkdirSync(pdir, { recursive: true });
        pictureMeta = pics.map(p => {
          const meta = { index: p.index, page: p.page ?? null, bbox: p.bbox ?? null, note: p.note ?? null, file: null };
          if (p.image_b64) {
            try { fs.writeFileSync(path.join(pdir, `${p.index}.png`), Buffer.from(p.image_b64, 'base64')); meta.file = `pictures/${p.index}.png`; }
            catch { meta.note = meta.note || 'falha ao salvar a imagem'; }
          }
          return meta;
        });
        fs.writeFileSync(path.join(dir, 'pictures.json'), JSON.stringify(pictureMeta), 'utf8');
      }
    } catch (e) { console.error('[docling] persistência das figuras falhou:', e.message); }

    // Valida a coerência das tabelas extraídas (linhas/colunas/cabeçalho).
    const tableSummary = summarizeTables(chunks);
    const warnings = Array.isArray(result.warnings) ? [...result.warnings] : [];
    if (tableSummary.withWarnings > 0) {
      warnings.push(`${tableSummary.withWarnings} tabela(s) com possível inconsistência de estrutura.`);
    }
    const unrenderedPics = pictureMeta.filter(p => !p.file).length;
    if (unrenderedPics > 0) warnings.push(`${unrenderedPics} elemento(s) visual(is) não puderam ser renderizados.`);
    const status = result.status && result.status !== 'done'
      ? result.status
      : (warnings.length ? 'done_warnings' : 'done');

    const stats = {
      pages: result.page_count ?? report.pages,
      tables: tableSummary.count || (result.table_count ?? 0),
      tablesWithWarnings: tableSummary.withWarnings,
      tableDetails: tableSummary.details,
      ocrUsed: !!result.ocr_used,
      chunks: chunks.length,
      tokensOriginal: tokenOriginal,
      tokensOptimized: tokenOptimized,
      savedPercent: econ.percent,
      duplicatePages: report.duplicatePages,
      removedHeaderFooterLines: report.removedHeaderFooterLines,
      semantic: semanticReady,
      pictureCount: pictureMeta.length,
      picturesUnrendered: unrenderedPics,
      timingMs: result.timing_ms ?? null,
    };

    await upsertRow({
      user_id: userId, conversation_id: conversationId, file_id: fileId, hash, mime, filename,
      config_version: cfg, engine: 'docling', status,
      ocr_used: !!result.ocr_used, page_count: result.page_count ?? report.pages,
      table_count: tableSummary.count, json_path: path.join(dir, 'document.json'),
      md_path: path.join(dir, 'optimized.md'), chunks_path: path.join(dir, 'chunks.json'),
      stats: JSON.stringify(stats), token_original: tokenOriginal, token_optimized: tokenOptimized,
      warnings: warnings.length ? JSON.stringify(warnings) : null, error: null,
    });
    return serialize(await getProcessingByHash(userId, hash, cfg));
  } catch (e) {
    await upsertRow({ user_id: userId, conversation_id: conversationId, file_id: fileId, hash, mime, filename,
      config_version: cfg, engine: 'docling', status: 'failed', error: String(e.message || e).slice(0, 500) });
    console.error('[docling] processFile falhou:', e.message);
    return serialize(await getProcessingByHash(userId, hash, cfg));
  }
}

// MIME simples a partir da extensão (o serviço confirma o tipo real depois).
const MIME_BY_EXT = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html', htm: 'text/html', md: 'text/markdown', csv: 'text/csv',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tiff: 'image/tiff', tif: 'image/tiff',
  bmp: 'image/bmp', webp: 'image/webp',
};
export function mimeForName(name = '') {
  return MIME_BY_EXT[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
}

// Dispara o processamento em segundo plano (não bloqueia o upload). processFile
// nunca lança; qualquer falha vira status 'failed' e o app segue no fallback.
export function kickProcessing(params) {
  if (!isDoclingEnabled() || !isDoclingSupported(params.filename || params.filePath || '')) return;
  Promise.resolve().then(() => processFile(params)).catch((e) => console.error('[docling] kick falhou:', e.message));
}

export { configVersion, serialize as serializeProcessing };
