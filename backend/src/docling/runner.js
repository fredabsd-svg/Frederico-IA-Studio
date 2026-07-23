// Cliente do docling-service (o serviço dedicado e permanente que carrega os
// modelos uma vez e processa documentos sob demanda). O backend NUNCA processa o
// PDF localmente: envia os bytes ao serviço pela REDE INTERNA do Docker, com um
// token compartilhado, e acompanha o job (fila/concorrência ficam no serviço).
//
// Contrato do serviço (interno, sem porta pública):
//   POST   /jobs        (multipart: file, hash, options)      -> { job_id, status }
//   GET    /jobs/:id                                          -> { status, stage, progress, result?, error? }
//   DELETE /jobs/:id                                          -> cancela
//   GET    /health                                            -> { status, models_loaded }
// Falha/timeout aqui => o chamador (service.js) cai no fallback (comportamento atual).
import fs from 'node:fs';
import path from 'node:path';

function baseUrl() {
  return (process.env.DOCLING_SERVICE_URL || 'http://docling-service:8000').replace(/\/+$/, '');
}
function authHeaders() {
  const token = process.env.DOCLING_INTERNAL_TOKEN || '';
  return token ? { 'X-Internal-Token': token } : {};
}

const TERMINAL = new Set(['done', 'done_warnings', 'partial', 'failed', 'canceled']);

export async function doclingHealth() {
  try {
    const res = await fetch(`${baseUrl()}/health`, { headers: authHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, ...(await res.json()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Enfileira um job. Envia os bytes do arquivo + hash + opções. O serviço deve
// deduplicar por (hash, config) e devolver imediatamente um job já concluído se
// o documento já estiver em cache.
async function submitJob(filePath, { hash, mime, filename, options }) {
  const buf = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime || 'application/octet-stream' }), filename || path.basename(filePath));
  form.append('hash', hash);
  form.append('options', JSON.stringify(options || {}));
  const res = await fetch(`${baseUrl()}/jobs`, { method: 'POST', headers: authHeaders(), body: form, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`docling-service /jobs HTTP ${res.status}`);
  return res.json(); // { job_id, status }
}

async function pollJob(jobId, { signal } = {}) {
  const res = await fetch(`${baseUrl()}/jobs/${encodeURIComponent(jobId)}`, { headers: authHeaders(), signal });
  if (!res.ok) throw new Error(`docling-service GET /jobs HTTP ${res.status}`);
  return res.json();
}

export async function cancelJob(jobId) {
  try {
    await fetch(`${baseUrl()}/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', headers: authHeaders(), signal: AbortSignal.timeout(5000) });
    return true;
  } catch { return false; }
}

// Processa um arquivo de ponta a ponta: enfileira e faz polling até terminar,
// reportando progresso via onProgress({ stage, progress }). Respeita timeoutMs
// (cancelando o job no serviço) e um AbortSignal externo (cancelamento do usuário).
export async function runDocling(filePath, { hash, mime, filename, options, timeoutMs = 240_000, onProgress, signal } = {}) {
  const started = Date.now();
  const submitted = await submitJob(filePath, { hash, mime, filename, options });
  const jobId = submitted.job_id;
  if (!jobId) throw new Error('docling-service não retornou job_id');

  // Já veio pronto do cache do serviço.
  if (TERMINAL.has(submitted.status) && submitted.result) {
    return { jobId, ...submitted.result, status: submitted.status };
  }

  const pollEvery = Math.max(500, Number(process.env.DOCLING_POLL_MS || 1500));
  while (true) {
    if (signal?.aborted) { await cancelJob(jobId); throw new Error('Processamento cancelado.'); }
    if (Date.now() - started > timeoutMs) { await cancelJob(jobId); throw new Error('Timeout no docling-service.'); }
    await new Promise(r => setTimeout(r, pollEvery));
    let job;
    try { job = await pollJob(jobId, { signal }); }
    catch (e) { if (signal?.aborted) throw e; continue; } // erro transitório: tenta de novo
    if (job.stage || typeof job.progress === 'number') onProgress?.({ stage: job.stage, progress: job.progress });
    if (TERMINAL.has(job.status)) {
      if (job.status === 'failed') throw new Error(job.error || 'Falha no docling-service.');
      if (job.status === 'canceled') throw new Error('Processamento cancelado.');
      return { jobId, ...(job.result || {}), status: job.status };
    }
  }
}
