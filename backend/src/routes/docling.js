// Rotas do Docling — status do serviço, resultados por documento e artefatos
// (Markdown otimizado, JSON completo, chunks). Alimentam o painel de
// processamento na interface e permitem auditar/baixar o que foi extraído.
import fs from 'node:fs';
import { db } from '../db.js';
import { makeRouter } from './helpers.js';
import { isDoclingEnabled, doclingOptions } from '../docling/config.js';
import { doclingHealth } from '../docling/runner.js';
import { getProcessingById, listProcessingsForConversation, readArtifacts, kickProcessing, mimeForName } from '../docling/service.js';
import { workspaceFor } from '../sandbox.js';
import path from 'node:path';

const router = makeRouter();

// Estado geral: ligado? serviço saudável? opções vigentes (para a UI/admin).
router.get('/docling/status', async (req, res) => {
  const enabled = isDoclingEnabled();
  const health = enabled ? await doclingHealth() : { ok: false, disabled: true };
  res.json({ enabled, options: doclingOptions(), health });
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
  kickProcessing({ userId: req.userId, conversationId: conv.conversation_id, fileId: f.id, filePath, filename: f.name, mime: f.mime || mimeForName(f.name), hash: f.hash });
  res.json({ ok: true, status: 'processing' });
});

export default router;
