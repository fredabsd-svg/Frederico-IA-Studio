// Recebimento de arquivos — política de memória, cotas e concorrência.
//
// PROBLEMA CORRIGIDO
// O multer estava em `memoryStorage()` com limites de 50 MB por arquivo e 20
// arquivos: uma única requisição podia colocar ~1 GB em BUFFER na RAM do Node,
// antes de qualquer cópia, hash ou antivírus (que faziam mais uma passada sobre
// os mesmos bytes). Bastavam duas requisições assim, em paralelo, para derrubar
// o backend por OOM numa VPS de 2–4 GB — sem nenhum limite total, sem cota por
// usuário e sem teto de uploads concorrentes.
//
// POLÍTICA NOVA
//   * armazenamento em DISCO (streaming para um temporário), nunca em RAM;
//   * teto por arquivo (UPLOAD_MAX_FILE_MB, 50), por requisição
//     (UPLOAD_MAX_REQUEST_MB, 200) e por quantidade (UPLOAD_MAX_FILES, 20);
//   * teto de requisições de upload SIMULTÂNEAS por usuário
//     (UPLOAD_MAX_CONCURRENT_PER_USER, 2) — backpressure explícito em vez de
//     esgotar memória/disco;
//   * cota de disco por usuário (UPLOAD_USER_QUOTA_MB, 0 = sem cota);
//   * limpeza garantida dos temporários, inclusive quando a requisição é
//     abortada no meio do envio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';

const MB = 1024 * 1024;
const num = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const UPLOAD_LIMITS = {
  maxFileBytes: Math.max(1, num('UPLOAD_MAX_FILE_MB', 50)) * MB,
  maxRequestBytes: Math.max(1, num('UPLOAD_MAX_REQUEST_MB', 200)) * MB,
  maxFiles: Math.max(1, num('UPLOAD_MAX_FILES', 20)),
  maxConcurrentPerUser: Math.max(1, num('UPLOAD_MAX_CONCURRENT_PER_USER', 2)),
  userQuotaBytes: num('UPLOAD_USER_QUOTA_MB', 0) * MB
};

export const uploadTmpRoot = path.join(path.resolve(process.env.DATA_DIR || './data'), 'tmp-uploads');

// ---- Armazenamento em disco -------------------------------------------------
// Cada requisição recebe um subdiretório próprio: a limpeza é um rmSync na
// pasta, o que também recolhe arquivos PARCIAIS de um envio interrompido.
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    try {
      if (!req._uploadStage) {
        req._uploadStage = fs.mkdtempSync(path.join(ensureTmpRoot(), 'req-'));
      }
      cb(null, req._uploadStage);
    } catch (e) { cb(e); }
  },
  filename(_req, _file, cb) {
    // Nome no staging é opaco de propósito: o nome original do usuário só é
    // usado (já saneado) no destino final, nunca no caminho temporário.
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
  }
});

function ensureTmpRoot() {
  try { fs.mkdirSync(uploadTmpRoot, { recursive: true }); return uploadTmpRoot; }
  catch { return os.tmpdir(); }
}

export const upload = multer({
  storage,
  limits: {
    fileSize: UPLOAD_LIMITS.maxFileBytes,
    files: UPLOAD_LIMITS.maxFiles,
    fields: 50,
    fieldSize: 1 * MB,
    // O multer/busboy não tem "total da requisição": o teto agregado é aplicado
    // por cleanupRequestUploads/enforceRequestTotal depois do parsing, e o
    // Content-Length é checado ANTES (rejectOversizedRequest).
    parts: UPLOAD_LIMITS.maxFiles + 60
  }
});

// ---- Erros do multer -> resposta HTTP ---------------------------------------
// Quando um teto do multer estoura (arquivo grande demais, arquivos demais,
// campo inesperado), ele chama next(err) com um MulterError. Sem este
// mapeamento, o tratador global respondia 500 "Erro interno" — o cliente não
// sabia que era LIMITE — e o parcial gravado em disco ficava no staging até a
// varredura horária. Regra 4.4: limite de upload = 413; pedido malformado = 400.
const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: () => `Um dos arquivos passa do limite de ${Math.round(UPLOAD_LIMITS.maxFileBytes / MB)} MB por arquivo.`,
  LIMIT_FILE_COUNT: () => `Envie no máximo ${UPLOAD_LIMITS.maxFiles} arquivos por vez.`,
  LIMIT_UNEXPECTED_FILE: () => 'Campo de arquivo inesperado neste envio.',
  LIMIT_PART_COUNT: () => 'O envio tem partes demais.',
  LIMIT_FIELD_KEY: () => 'Nome de campo longo demais no envio.',
  LIMIT_FIELD_VALUE: () => 'Um dos campos do envio passa do tamanho permitido.',
  LIMIT_FIELD_COUNT: () => 'O envio tem campos demais.',
  MISSING_FIELD_NAME: () => 'Campo do envio sem nome.'
};
const MULTER_BAD_REQUEST = new Set(['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'MISSING_FIELD_NAME']);

// PURA: devolve { status, body } para um erro do multer, ou null quando o erro
// não é do multer (o chamador segue o tratamento genérico).
export function uploadErrorResponse(err) {
  if (!(err instanceof multer.MulterError) && !(err?.name === 'MulterError' && typeof err?.code === 'string')) return null;
  const code = String(err.code || '');
  const status = MULTER_BAD_REQUEST.has(code) ? 400 : (code.startsWith('LIMIT_') ? 413 : 400);
  const message = (MULTER_MESSAGES[code] || (() => 'Envio de arquivo inválido.'))();
  return { status, body: { error: message, code: `upload_${code.toLowerCase()}` } };
}

// Middleware de erro (4 argumentos) para montar ANTES do tratador global:
// responde o erro do multer com o status certo e SEMPRE limpa o staging.
export function uploadErrorHandler(err, req, res, next) {
  const mapped = uploadErrorResponse(err);
  if (!mapped) return next(err);
  cleanupRequestUploads(req);
  if (res.headersSent) return res.end();
  return res.status(mapped.status).json(mapped.body);
}

// Remove todo o staging da requisição. Idempotente; nunca lança.
export function cleanupRequestUploads(req) {
  const stage = req?._uploadStage;
  if (!stage) return;
  req._uploadStage = null;
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
}

// ---- Teto agregado por requisição ------------------------------------------
export function totalUploadBytes(files = []) {
  return files.reduce((sum, f) => sum + Number(f.size || 0), 0);
}

// Rejeita ANTES de ler o corpo, pelo Content-Length declarado. É a primeira
// linha: evita gravar 1 GB em disco só para depois descobrir que estourou.
export function rejectOversizedRequest(req, res) {
  const declared = Number(req.headers?.['content-length'] || 0);
  // Margem de 1 MB para os cabeçalhos multipart do próprio corpo.
  if (declared && declared > UPLOAD_LIMITS.maxRequestBytes + MB) {
    res.status(413).json({
      error: `O envio total passa do limite de ${Math.round(UPLOAD_LIMITS.maxRequestBytes / MB)} MB por requisição. Envie os arquivos em lotes menores.`,
      code: 'upload_request_too_large',
      limiteMb: Math.round(UPLOAD_LIMITS.maxRequestBytes / MB)
    });
    return true;
  }
  return false;
}

// ---- Concorrência por usuário ----------------------------------------------
const inFlight = new Map(); // userId -> contagem

export function acquireUploadSlot(userId) {
  const key = String(userId || 'anon');
  const current = inFlight.get(key) || 0;
  if (current >= UPLOAD_LIMITS.maxConcurrentPerUser) return null;
  inFlight.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(key) || 1) - 1;
    if (left <= 0) inFlight.delete(key);
    else inFlight.set(key, left);
  };
}

export function uploadSlotsInUse(userId) {
  return inFlight.get(String(userId || 'anon')) || 0;
}

// ---- Cota de disco por usuário ---------------------------------------------
export function directorySize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { total += directorySize(full); continue; }
    try { total += fs.statSync(full).size; } catch {}
  }
  return total;
}

// PURA: decide se o lote cabe na cota. usedBytes/incomingBytes já apurados.
export function quotaVerdict({ usedBytes, incomingBytes, quotaBytes = UPLOAD_LIMITS.userQuotaBytes }) {
  if (!quotaBytes) return { ok: true };
  if (usedBytes + incomingBytes <= quotaBytes) return { ok: true, usedBytes, quotaBytes };
  return {
    ok: false,
    usedBytes,
    quotaBytes,
    error: `Este envio passa da sua cota de armazenamento (${Math.round(quotaBytes / MB)} MB). Já em uso: ${Math.round(usedBytes / MB)} MB. Apague arquivos antigos das conversas antes de enviar mais.`,
    code: 'upload_quota_exceeded'
  };
}

// Hash de conteúdo por STREAMING (base do cache/dedup do Docling). A versão
// antiga hasheava o Buffer inteiro em memória — aqui o arquivo nunca é carregado
// de uma vez.
export function hashFileStreamSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// Move o temporário para o destino final. rename() quando possível (mesma
// partição, custo zero); copy+unlink quando cruza dispositivo (EXDEV).
export function commitUploadedFile(tempPath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    fs.renameSync(tempPath, targetPath);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(tempPath, targetPath);
    try { fs.unlinkSync(tempPath); } catch {}
  }
  try { fs.chownSync(targetPath, 1000, 1000); } catch {}
  return fs.statSync(targetPath).size;
}

// Varre temporários abandonados (queda do processo no meio de um upload).
export function sweepStaleUploadTemps({ olderThanMs = 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(uploadTmpRoot, { withFileTypes: true }); } catch { return { removed }; }
  for (const entry of entries) {
    const full = path.join(uploadTmpRoot, entry.name);
    try {
      if (nowMs - fs.statSync(full).mtimeMs < olderThanMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return { removed };
}
