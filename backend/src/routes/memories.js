// Rotas de memories — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import fs from 'node:fs';
import { listMemories, addMemory, updateMemory, deleteMemory, deleteAllMemories, exportAll, reindexAll, getSettings, setSettings, invalidSettingKeys, looksSensitive, listMemorySuggestions, updateMemorySuggestion, approveMemorySuggestion, rejectMemorySuggestion } from '../memory/memoryService.js';
import { startImport, getImportStatus } from '../memory/indexer.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, upload, scanOrReject, decodeUploadName, beginUpload, cleanupRequestUploads, requireAdmin, recordAdminAction } from './helpers.js';

const router = makeRouter();

// ---- Memória de longo prazo (Cérebro do Assistente) ----
router.get('/memories', async (req, res) => {
  try {
    res.json(await listMemories(req.userId, { query: req.query.query || '', type: req.query.type || '', scope: req.query.scope || '' }));
  } catch (err) {
    // O detalhe (SQL, caminho, stack) fica no log; o cliente recebe só a
    // mensagem genérica (Regra 4.4).
    console.error('[memória] falha ao listar:', err);
    res.status(500).json({ error: 'Não foi possível carregar as memórias agora. Tente de novo em instantes.' });
  }
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
  try { res.json(await reindexAll(req.userId)); }
  catch (err) {
    console.error('[memória] falha ao reindexar:', err);
    res.status(500).json({ error: 'Não foi possível reindexar a memória agora. Tente de novo em instantes.' });
  }
});

// ---- Importação de conversas antigas ----
// O progresso é POR USUÁRIO (memory/indexer.js): cada conta só enxerga a
// própria importação — nunca o nome do arquivo ou a contagem de outra conta —
// e a importação de uma conta não bloqueia a das outras.
export function importStatusFor(userId) {
  return getImportStatus(userId);
}

// Inicia a importação em segundo plano; o progresso é consultado via /import-status.
// Mesmo portão das demais rotas de upload: Content-Length e concorrência antes
// do multer, antivírus, e o temporário SEMPRE removido no finally.
router.post('/memories/import', (req, res, next) => {
  const gate = beginUpload(req, res);
  if (!gate) return;
  res.on('close', gate.release);
  res.on('finish', gate.release);
  next();
}, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const scan = await scanOrReject(res, [req.file], req);
    if (!scan) return;
    if (scan.rejected.length) return res.status(422).json({ error: `Arquivo recusado pelo antivírus (ameaça detectada: ${scan.rejected[0].virus}).` });
    // O multer grava em DISCO (uploads.js): não existe `req.file.buffer`. Lê o
    // temporário ANTES do finally apagá-lo.
    let content;
    try { content = fs.readFileSync(req.file.path); }
    catch (err) {
      console.error('[memória] falha ao ler o arquivo importado:', err);
      return res.status(500).json({ error: 'Não foi possível ler o arquivo enviado. Tente de novo.' });
    }
    const r = startImport(req.userId, decodeUploadName(req.file.originalname), content, req.query.scope || 'global');
    if (!r.ok) return res.status(r.status || 409).json({ error: r.error });
    res.json({ started: true });
  } finally {
    cleanupRequestUploads(req);
  }
});

router.get('/memories/import-status', (req, res) => res.json(importStatusFor(req.userId)));

// Configurações GLOBAIS (valem para todos os usuários da instalação). Ler é
// livre — a interface precisa saber o que está em vigor —, mas ALTERAR é ação
// administrativa, auditada. Valores numéricos fora da faixa são grampeados
// (memoryService.SETTINGS_LIMITS); valor que não é número responde 400.
router.get('/memory-config', (_, res) => res.json(getSettings()));
router.put('/memory-config', async (req, res) => {
  if (!await requireAdmin(req, res, 'Apenas o administrador pode alterar a configuração da memória.')) return;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const invalid = invalidSettingKeys(body);
  if (invalid.length) return res.status(400).json({ error: `Valor inválido para: ${invalid.join(', ')}.`, invalid });
  const saved = await setSettings(body);
  await recordAdminAction(req, 'memory-config.update', { chaves: Object.keys(body).slice(0, 20) });
  res.json(saved);
});

// Configuração da rede do sandbox (execução isolada por conversa). Endpoint
// dedicado para não acoplar a UI de segurança ao painel de memória, ainda que
// ambos usem a mesma tabela de settings. É uma política GLOBAL de rede do
// código executado — só o administrador altera, e só para 0, 1 ou 2 (valor
// fora disso é 400, não "vira 0" em silêncio).
router.get('/sandbox-config', (_, res) => res.json({ sandbox_network_policy: getSettings().sandbox_network_policy }));
router.put('/sandbox-config', async (req, res) => {
  if (!await requireAdmin(req, res, 'Apenas o administrador pode alterar a política de rede do sandbox.')) return;
  const policy = { sandbox_network_policy: req.body?.sandbox_network_policy };
  if (invalidSettingKeys(policy).length || policy.sandbox_network_policy === undefined) {
    return res.status(400).json({ error: 'Política de rede inválida: use 0 (automática), 1 (sempre ligada) ou 2 (sempre desligada).' });
  }
  const s = await setSettings(policy);
  await recordAdminAction(req, 'sandbox-config.update', { sandbox_network_policy: s.sandbox_network_policy });
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
