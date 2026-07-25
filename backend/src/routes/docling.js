// Rotas do Docling — status do serviço, resultados por documento e artefatos
// (Markdown otimizado, JSON completo, chunks). Alimentam o painel de
// processamento na interface e permitem auditar/baixar o que foi extraído.
import fs from 'node:fs';
import { db, now } from '../db.js';
import { makeRouter, isAdmin } from './helpers.js';
import { isDoclingEnabled } from '../docling/config.js';
import { resolvedOptions, writeOverrides, readOverrides, adminEditable } from '../docling/adminConfig.js';
import { doclingHealth } from '../docling/runner.js';
import { getProcessingById, listProcessingsForConversation, readArtifacts, kickProcessing, mimeForName, abortProcessing } from '../docling/service.js';
import { summarizeTables, tableToCsv } from '../docling/tables.js';
import { purgeProcessing } from '../docling/retention.js';
import { workspaceFor } from '../sandbox.js';
import path from 'node:path';

const router = makeRouter();

// Estado geral: ligado? serviço saudável? opções vigentes (para a UI/admin).
router.get('/docling/status', async (req, res) => {
  const enabled = isDoclingEnabled();
  const health = enabled ? await doclingHealth() : { ok: false, disabled: true };
  const opts = await resolvedOptions();
  res.json({ enabled, isAdmin: isAdmin(req), options: adminEditable(opts), overrides: await readOverrides(), health });
});

// Ajuste das opções do Docling (somente admin). Muda o configVersion → o cache
// é invalidado e os documentos são reprocessados sob demanda.
router.put('/docling/config', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas o administrador pode alterar a configuração do Docling.' });
  const saved = await writeOverrides(req.body || {});
  res.json({ ok: true, overrides: saved, options: adminEditable(await resolvedOptions()) });
});

// Documentos processados (ou em processamento) da conversa.
router.get('/docling/conversations/:id/documents', async (req, res) => {
  res.json(await listProcessingsForConversation(req.userId, req.params.id));
});

router.get('/docling/documents/:id', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  res.json(row);
});

// Markdown otimizado (o que é enviado à IA).
router.get('/docling/documents/:id/markdown', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  const arts = readArtifacts(req.userId, row.hash, row.configVersion);
  if (!arts.markdown) return res.status(404).json({ error: 'Markdown indisponível' });
  res.type('text/markdown').send(arts.markdown);
});

// Chunks semânticos (com página/seção/tipo/referência).
router.get('/docling/documents/:id/chunks', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  const arts = readArtifacts(req.userId, row.hash, row.configVersion);
  res.json(arts.chunks || []);
});

// Tabelas identificadas (com página/seção e validação de coerência).
router.get('/docling/documents/:id/tables', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  const arts = readArtifacts(req.userId, row.hash, row.configVersion);
  res.json(summarizeTables(arts.chunks || []).details);
});

// Exporta UMA tabela como CSV (download). O índice vem de summarizeTables/chunks.
router.get('/docling/documents/:id/tables/:index/csv', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  const arts = readArtifacts(req.userId, row.hash, row.configVersion);
  const idx = Number(req.params.index);
  const tables = (arts.chunks || []).filter(c => c.type === 'table');
  const table = tables.find((c, i) => (c.tableIndex ?? i + 1) === idx);
  if (!table) return res.status(404).json({ error: 'Tabela não encontrada' });
  const csv = tableToCsv(table.content);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tabela_${idx}.csv"`);
  res.send('﻿' + csv); // BOM para o Excel abrir acentos corretamente
});

// Elementos visuais (figuras/gráficos/assinaturas) com página e referência.
router.get('/docling/documents/:id/pictures', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  const arts = readArtifacts(req.userId, row.hash, row.configVersion);
  res.json((arts.pictures || []).map(p => ({ index: p.index, page: p.page, note: p.note, hasImage: !!p.file })));
});

// Imagem de UM elemento visual (PNG).
router.get('/docling/documents/:id/pictures/:index', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  const arts = readArtifacts(req.userId, row.hash, row.configVersion);
  const pic = (arts.pictures || []).find(p => String(p.index) === String(req.params.index));
  if (!pic?.file || !fs.existsSync(pic.file)) return res.status(404).json({ error: 'Imagem indisponível' });
  res.type('image/png');
  fs.createReadStream(pic.file).pipe(res);
});

// JSON completo do Docling (a "fonte da verdade" — para auditoria/reprocesso).
router.get('/docling/documents/:id/json', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  const arts = readArtifacts(req.userId, row.hash, row.configVersion);
  if (!arts.jsonPath || !fs.existsSync(arts.jsonPath)) return res.status(404).json({ error: 'JSON indisponível' });
  res.type('application/json');
  fs.createReadStream(arts.jsonPath).pipe(res);
});

// Reprocessa (ex.: após alterar configuração de OCR): re-dispara em segundo plano.
router.post('/docling/documents/:id/reprocess', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  const f = await db.prepare('SELECT * FROM files WHERE id=(SELECT file_id FROM document_processings WHERE id=? AND user_id=?)').get(req.params.id, req.userId);
  const conv = await db.prepare('SELECT conversation_id FROM document_processings WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!f || !conv?.conversation_id) return res.status(409).json({ error: 'Arquivo original indisponível para reprocessar.' });
  const ws = workspaceFor(conv.conversation_id);
  const filePath = path.join(ws.base, f.path);
  if (!fs.existsSync(filePath)) return res.status(409).json({ error: 'Arquivo original não está mais no disco.' });
  // force: ignora o cache — reprocessar com a mesma config deve reprocessar de
  // verdade (era um no-op: o processFile devolvia o resultado cacheado).
  kickProcessing({ userId: req.userId, conversationId: conv.conversation_id, fileId: f.id, filePath, filename: f.name, mime: f.mime || mimeForName(f.name), hash: f.hash || row.hash, force: true });
  res.json({ ok: true, status: 'processing' });
});

// Cancela um processamento em andamento (documento grande, OCR demorado...).
// O caminho existia inteiro no serviço Python (DELETE /jobs/:id) e no runner
// (AbortSignal), mas não havia rota nem botão — o usuário não tinha como parar.
router.post('/docling/documents/:id/cancel', async (req, res) => {
  const row = await getProcessingById(req.userId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  if (!['queued', 'processing'].includes(row.status)) {
    return res.status(409).json({ error: 'Este documento não está em processamento.' });
  }
  const aborted = abortProcessing(req.userId, row.hash, row.configVersion);
  // Não estar em memória significa que o backend reiniciou no meio: a linha
  // ficaria "processando" para sempre. Marcamos como cancelada de qualquer forma.
  if (!aborted) {
    await db.prepare("UPDATE document_processings SET status='canceled', updated_at=? WHERE id=? AND user_id=?")
      .run(now(), req.params.id, req.userId);
  }
  res.json({ ok: true, aborted });
});

// LGPD: apaga os dados DERIVADOS de um documento (JSON/Markdown/chunks/
// embeddings/figuras). Não remove o arquivo original — só os artefatos, que são
// reprocessáveis. Reenviar/reprocessar o documento os recria.
router.delete('/docling/documents/:id', async (req, res) => {
  const ok = await purgeProcessing(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ ok: true });
});

export default router;
