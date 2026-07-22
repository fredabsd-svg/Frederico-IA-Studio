import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { encryptSecret, decryptSecret, maskSecret } from '../crypto.js';
import { getUserProvider } from '../userProvider.js';
import { importProviderCatalog, normalizeProviderType, PROVIDER_PRESETS } from '../providerCatalog.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

function modelCount(row) {
  try { const models = JSON.parse(row.models || '[]'); return Array.isArray(models) ? models.length : 0; }
  catch { return 0; }
}

function publicProvider(row) {
  const key = decryptSecret(row.api_key_enc);
  return {
    id: row.id,
    providerType: row.provider_type,
    name: row.name,
    base_url: row.base_url,
    keyMask: key ? maskSecret(key) : '',
    modelCount: modelCount(row),
    defaultModel: row.default_model || '',
    lastValidatedAt: row.last_validated_at || null
  };
}

async function rowsFor(userId) {
  return db.prepare('SELECT * FROM user_ai_providers WHERE user_id=? ORDER BY created_at ASC').all(userId);
}

async function validateBody(body, existing = null) {
  const type = normalizeProviderType(body.providerType || existing?.provider_type);
  const preset = PROVIDER_PRESETS[type];
  const apiKey = String(body.apiKey || (existing ? decryptSecret(existing.api_key_enc) : '') || '').trim();
  const baseURL = String(body.base_url || existing?.base_url || preset.baseURL || '').trim();
  const modelHint = String(body.model || body.defaultModel || existing?.default_model || '').trim();
  const imported = await importProviderCatalog({ apiKey, baseURL, providerType: type, modelHint });
  return {
    type,
    name: String(body.name || existing?.name || preset.name || 'Provedor').trim().slice(0, 80),
    apiKey,
    baseURL: imported.baseURL,
    models: imported.models,
    defaultModel: modelHint && imported.models.some(model => model.id === modelHint) ? modelHint : imported.models[0]?.id || '',
    validation: imported.validation
  };
}

router.get('/providers', async (req, res) => {
  const providers = (await rowsFor(req.userId)).map(publicProvider);
  res.json({ providers });
});

router.post('/providers', async (req, res) => {
  try {
    const checked = await validateBody(req.body || {});
    const id = nanoid();
    const t = now();
    await db.prepare(`INSERT INTO user_ai_providers
      (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,last_validated_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, checked.type, checked.name, checked.baseURL, encryptSecret(checked.apiKey), JSON.stringify(checked.models), checked.defaultModel || null, t, t, t);
    res.status(201).json({ ok: true, provider: publicProvider((await rowsFor(req.userId)).find(row => row.id === id)), imported: checked.models.length, validation: checked.validation });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || 'Não foi possível validar a chave.' });
  }
});

router.put('/providers/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM user_ai_providers WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Provedor não encontrado.' });
  try {
    const checked = await validateBody(req.body || {}, existing);
    const t = now();
    await db.prepare(`UPDATE user_ai_providers SET provider_type=?,name=?,base_url=?,api_key_enc=?,models=?,default_model=?,last_validated_at=?,updated_at=? WHERE id=? AND user_id=?`)
      .run(checked.type, checked.name, checked.baseURL, encryptSecret(checked.apiKey), JSON.stringify(checked.models), checked.defaultModel || null, t, t, existing.id, req.userId);
    res.json({ ok: true, imported: checked.models.length, validation: checked.validation });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || 'Não foi possível validar a chave.' });
  }
});

router.post('/providers/:id/refresh', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM user_ai_providers WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Provedor não encontrado.' });
  try {
    const checked = await validateBody({}, existing);
    const t = now();
    await db.prepare('UPDATE user_ai_providers SET models=?,default_model=?,last_validated_at=?,updated_at=? WHERE id=? AND user_id=?')
      .run(JSON.stringify(checked.models), checked.defaultModel || null, t, t, existing.id, req.userId);
    res.json({ ok: true, imported: checked.models.length });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || 'Não foi possível atualizar os modelos.' });
  }
});

router.delete('/providers/:id', async (req, res) => {
  const result = await db.prepare('DELETE FROM user_ai_providers WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!result.changes) return res.status(404).json({ error: 'Provedor não encontrado.' });
  res.json({ ok: true });
});

// Compatibilidade com clientes antigos: o status agora representa o conjunto.
router.get('/provider', async (req, res) => {
  const providers = (await rowsFor(req.userId)).map(publicProvider);
  const active = await getUserProvider(req.userId);
  res.json({
    hasKey: providers.length > 0 || active.source === 'free',
    source: providers.length ? 'user' : active.source,
    providers,
    ...(active.source === 'free' ? { freeProvider: active.providerName, freeModel: active.model, freeModels: active.freeModels } : {})
  });
});

router.post('/provider/test', async (req, res) => {
  try {
    const checked = await validateBody(req.body || {});
    res.json({ ok: true, imported: checked.models.length, validation: checked.validation });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || 'A chave não foi aceita pelo provedor.' });
  }
});

// PUT legado deixa de salvar sem validar. Se já houver um provedor, atualiza o
// primeiro; caso contrário cria um novo registro validado.
router.put('/provider', async (req, res) => {
  const existing = (await rowsFor(req.userId))[0];
  if (req.body?.apiKey === '' && existing) {
    await db.prepare('DELETE FROM user_ai_providers WHERE id=? AND user_id=?').run(existing.id, req.userId);
    return res.json({ ok: true });
  }
  try {
    const checked = await validateBody(req.body || {}, existing || null);
    const t = now();
    if (existing) {
      await db.prepare('UPDATE user_ai_providers SET provider_type=?,name=?,base_url=?,api_key_enc=?,models=?,default_model=?,last_validated_at=?,updated_at=? WHERE id=? AND user_id=?')
        .run(checked.type, checked.name, checked.baseURL, encryptSecret(checked.apiKey), JSON.stringify(checked.models), checked.defaultModel || null, t, t, existing.id, req.userId);
    } else {
      await db.prepare('INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,last_validated_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(nanoid(), req.userId, checked.type, checked.name, checked.baseURL, encryptSecret(checked.apiKey), JSON.stringify(checked.models), checked.defaultModel || null, t, t, t);
    }
    res.json({ ok: true, imported: checked.models.length });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || 'Não foi possível validar a chave.' });
  }
});

export default router;
