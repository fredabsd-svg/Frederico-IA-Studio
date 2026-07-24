// Rotas de memories — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { listMemories, addMemory, updateMemory, deleteMemory, deleteAllMemories, exportAll, reindexAll, getSettings, setSettings, looksSensitive, listMemorySuggestions, updateMemorySuggestion, approveMemorySuggestion, rejectMemorySuggestion } from '../memory/memoryService.js';
import { startImport, importStatus } from '../memory/indexer.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, upload, scanOrReject, decodeUploadName } from './helpers.js';

const router = makeRouter();

// ---- Memória de longo prazo (Cérebro do Assistente) ----
router.get('/memories', async (req, res) => {
  try {
    res.json(await listMemories(req.userId, { query: req.query.query || '', type: req.query.type || '', scope: req.query.scope || '' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/memories', validate(schemas.memoryCreate), async (req, res) => {
  try {
    const b = req.body || {};
    if (looksSensitive(b.content)) return res.status(400).json({ error: 'Este conteúdo parece conter senha/chave — por segurança, não é salvo na memória.' });
    res.json(await addMemory(req.userId, { content: b.content, type: b.type || 'manual', scope: b.scope || 'global', importance: Number(b.importance) || 3, pinned: b.pinned ? 1 : 0, tags: b.tags || null, source_type: 'manual' }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/memories/:id', validate(schemas.memoryUpdate), async (req, res) => {
  try {
    const m = await updateMemory(req.userId, req.params.id, req.body || {});
    if (!m) return res.status(404).json({ error: 'Não encontrado' });
    res.json(m);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/memories/:id', async (req, res) => { await deleteMemory(req.userId, req.params.id); res.json({ ok: true }); });

router.delete('/memories', async (req, res) => {
  await deleteAllMemories(req.userId, { scope: req.query.scope || null, source_type: req.query.source_type || null });
  res.json({ ok: true });
});

router.get('/memory-suggestions', async (req, res) => {
  res.json(await listMemorySuggestions(req.userId, { status: req.query.status || 'pending', limit: req.query.limit || 100 }));
});

router.put('/memory-suggestions/:id', validate(schemas.memoryUpdate), async (req, res) => {
  try {
    const s = await updateMemorySuggestion(req.userId, req.params.id, req.body || {});
    if (!s) return res.status(404).json({ error: 'Não encontrado' });
    res.json(s);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/memory-suggestions/:id/approve', async (req, res) => {
  try {
    const r = await approveMemorySuggestion(req.userId, req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/memory-suggestions/:id/reject', async (req, res) => {
  const s = await rejectMemorySuggestion(req.userId, req.params.id);
  if (!s) return res.status(404).json({ error: 'Não encontrado' });
  res.json(s);
});

router.get('/memories/export', async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="memoria-frederico-ai.json"');
  res.json(await exportAll(req.userId));
});

router.post('/memories/reindex', async (req, res) => {
  try { res.json(await reindexAll(req.userId)); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Inicia a importação em segundo plano; o progresso é consultado via /import-status
router.post('/memories/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const scan = await scanOrReject(res, [req.file]);
  if (!scan) return;
  if (scan.rejected.length) return res.status(422).json({ error: `Arquivo recusado pelo antivírus (ameaça detectada: ${scan.rejected[0].virus}).` });
  const r = startImport(req.userId, decodeUploadName(req.file.originalname), req.file.buffer, req.query.scope || 'global');
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ started: true });
});

router.get('/memories/import-status', (_, res) => res.json(importStatus));

router.get('/memory-config', (_, res) => res.json(getSettings()));
router.put('/memory-config', async (req, res) => res.json(await setSettings(req.body || {})));

// Configuração da rede do sandbox (execução isolada por conversa). Endpoint
// dedicado para não acoplar a UI de segurança ao painel de memória, ainda que
// ambos usem a mesma tabela de settings.
router.get('/sandbox-config', (_, res) => res.json({ sandbox_network_policy: getSettings().sandbox_network_policy }));
router.put('/sandbox-config', async (req, res) => {
  const raw = Number(req.body?.sandbox_network_policy);
  const policy = [0, 1, 2].includes(raw) ? raw : 0;
  const s = await setSettings({ sandbox_network_policy: policy });
  res.json({ sandbox_network_policy: s.sandbox_network_policy });
});

// Rotas legadas (compatibilidade com versões antigas da interface)
router.get('/memory', async (req, res) => {
  res.json(await listMemories(req.userId, { scope: req.query.scope || 'global' }));
});
router.post('/memory', async (req, res) => {
  try { res.json(await addMemory(req.userId, { content: req.body?.content, scope: req.body?.scope || 'global' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/memory/:id', async (req, res) => { await deleteMemory(req.userId, req.params.id); res.json({ ok: true }); });

export default router;
