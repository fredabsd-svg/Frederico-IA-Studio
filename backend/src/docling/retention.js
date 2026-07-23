// Retenção e exclusão dos artefatos derivados do Docling (LGPD). O JSON completo,
// o Markdown, os chunks, os embeddings e as figuras ficam num cache no disco do
// backend, fora do workspace da conversa — então apagar a conversa/arquivo NÃO
// os removia. Este módulo fecha essa lacuna:
//   * quando o usuário apaga um arquivo/conversa e o documento (hash) não é mais
//     referenciado por nenhum arquivo dele, os derivados são apagados;
//   * uma varredura periódica remove derivados antigos (retenção configurável);
//   * o usuário pode apagar explicitamente os derivados de um documento.
import fs from 'node:fs';
import { db } from '../db.js';
import { artifactDir } from './service.js';

// Um documento (hash) ainda pertence ao usuário? (algum arquivo dele com esse
// hash). files não tem user_id — junta com conversations para escopar por dono.
export async function userStillHasHash(userId, hash) {
  const row = await db.prepare(
    `SELECT 1 FROM files f JOIN conversations c ON f.conversation_id = c.id
     WHERE c.user_id = ? AND f.hash = ? LIMIT 1`
  ).get(userId, hash);
  return !!row;
}

// Apaga o diretório de artefatos de uma linha de processamento (idempotente).
function removeArtifacts(userId, hash, cfg) {
  try { fs.rmSync(artifactDir(userId, hash, cfg), { recursive: true, force: true }); } catch {}
}

// Apaga UMA linha de processamento + seus artefatos.
export async function purgeProcessing(userId, id) {
  const row = await db.prepare('SELECT * FROM document_processings WHERE id=? AND user_id=?').get(id, userId);
  if (!row) return false;
  removeArtifacts(userId, row.hash, row.config_version);
  await db.prepare('DELETE FROM document_processings WHERE id=? AND user_id=?').run(id, userId);
  return true;
}

// Apaga TODOS os processamentos de um hash (todas as versões de config) + artefatos.
export async function purgeByHash(userId, hash) {
  const rows = await db.prepare('SELECT * FROM document_processings WHERE user_id=? AND hash=?').all(userId, hash);
  for (const r of rows) removeArtifacts(userId, r.hash, r.config_version);
  const res = await db.prepare('DELETE FROM document_processings WHERE user_id=? AND hash=?').run(userId, hash);
  return res.changes || 0;
}

// Após apagar um arquivo: se o usuário não tem mais NENHUM arquivo com aquele
// hash, remove os derivados (o documento deixou de existir para ele).
export async function purgeIfOrphan(userId, hash) {
  if (!hash) return 0;
  if (await userStillHasHash(userId, hash)) return 0;
  return purgeByHash(userId, hash);
}

// Após apagar uma conversa: remove os derivados de todos os hashes que não
// pertencem mais a nenhum arquivo do usuário. `hashes` são os hashes dos
// arquivos que existiam na conversa apagada (coletados ANTES da exclusão).
export async function purgeOrphansForHashes(userId, hashes = []) {
  let removed = 0;
  for (const h of [...new Set(hashes.filter(Boolean))]) removed += await purgeIfOrphan(userId, h);
  return removed;
}

// Decisão pura (testável): um processamento está expirado?
export function isExpired(updatedAtIso, retentionDays, nowMs) {
  const days = Number(retentionDays) || 0;
  if (days <= 0) return false; // retenção desligada
  const t = Date.parse(updatedAtIso);
  if (Number.isNaN(t)) return false;
  return (nowMs - t) > days * 24 * 60 * 60 * 1000;
}

export const RETENTION_DAYS = Math.max(0, Number(process.env.DOCLING_RETENTION_DAYS || 0));

// Varredura periódica: apaga os derivados mais antigos que a retenção. Não toca
// nos arquivos originais do usuário — só nos artefatos derivados (reprocessáveis).
export async function sweepExpiredArtifacts(days = RETENTION_DAYS, nowMs = Date.now()) {
  if (!days || days <= 0) return 0;
  const rows = await db.prepare('SELECT id, user_id, hash, config_version, updated_at FROM document_processings').all();
  let removed = 0;
  for (const r of rows) {
    if (isExpired(r.updated_at, days, nowMs)) {
      removeArtifacts(r.user_id, r.hash, r.config_version);
      await db.prepare('DELETE FROM document_processings WHERE id=?').run(r.id);
      removed++;
    }
  }
  if (removed) console.log(`[docling] retenção: ${removed} documento(s) derivado(s) apagado(s) (> ${days} dias).`);
  return removed;
}
