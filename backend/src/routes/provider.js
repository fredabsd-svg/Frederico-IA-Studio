import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { encryptSecret, decryptSecret, maskSecret } from '../crypto.js';
import { getUserProvider } from '../userProvider.js';
import { enrichProviderCatalog, fetchProviderBalance, importProviderCatalog, normalizeProviderType, providerPublicMetadata, PROVIDER_PRESETS } from '../providerCatalog.js';
import { modelProfileFromProvider } from '../modelCapabilities.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

function modelCount(row) {
  try { const models = JSON.parse(row.models || '[]'); return Array.isArray(models) ? models.length : 0; }
  catch { return 0; }
}

function parsedJson(value, fallback = null) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

async function publicProvider(row) {
  const key = decryptSecret(row.api_key_enc);
  const usageRows = await db.prepare(`SELECT model,prompt_tokens,completion_tokens,total_tokens
    FROM usage WHERE user_id=? AND model LIKE ?`).all(row.user_id, `${row.id}::%`).catch(() => []);
  const catalog = new Map(enrichProviderCatalog(parsedJson(row.models, []), row.provider_type)
    .map(model => [model.id, modelProfileFromProvider(model)]));
  const usage = usageRows.reduce((total, item) => {
    total.messages += 1;
    total.promptTokens += Number(item.prompt_tokens || 0);
    total.completionTokens += Number(item.completion_tokens || 0);
    total.tokens += Number(item.total_tokens || 0);
    const rawId = String(item.model || '').slice(`${row.id}::`.length);
    const profile = catalog.get(rawId);
    if (profile?.pricingKnown) {
      total.estimatedCost += Number(item.prompt_tokens || 0) * profile.price + Number(item.completion_tokens || 0) * profile.priceOut;
      total.pricedMessages += 1;
    }
    return total;
  }, { messages: 0, promptTokens: 0, completionTokens: 0, tokens: 0, estimatedCost: 0, pricedMessages: 0 });
  const metadata = providerPublicMetadata(row.provider_type);
  const lastSync = row.last_validated_at ? new Date(row.last_validated_at).getTime() : 0;
  return {
    id: row.id,
    providerType: row.provider_type,
    name: row.name,
    base_url: row.base_url,
    keyMask: key ? maskSecret(key) : '',
    modelCount: modelCount(row),
    defaultModel: row.default_model || '',
    lastValidatedAt: row.last_validated_at || null,
    syncDue: !lastSync || Date.now() - lastSync > 12 * 60 * 60 * 1000,
    syncStatus: row.last_sync_status || (row.last_validated_at ? 'ok' : 'pending'),
    syncError: row.last_sync_error || '',
    dashboardURL: metadata.dashboardURL,
    billingURL: row.billing_url || metadata.billingURL,
    officialBalanceSupported: metadata.officialBalanceSupported,
    officialBalance: parsedJson(row.balance_info),
    balanceCheckedAt: row.balance_checked_at || null,
    usage: {
      ...usage
    }
  };
}

async function rowsFor(userId) {
  return db.prepare('SELECT * FROM user_ai_providers WHERE user_id=? ORDER BY created_at ASC').all(userId);
}

function optionalExternalURL(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('O link de cobrança é inválido.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('O link de cobrança deve usar HTTP/HTTPS e não pode conter credenciais.');
  }
  return raw.slice(0, 500);
}

async function validateBody(body, existing = null, { automatic = false } = {}) {
  const type = normalizeProviderType(body.providerType || existing?.provider_type);
  const preset = PROVIDER_PRESETS[type];
  const apiKey = String(body.apiKey || (existing ? decryptSecret(existing.api_key_enc) : '') || '').trim();
  const baseURL = String(body.base_url || existing?.base_url || preset.baseURL || '').trim();
  const modelHint = String(body.model || body.defaultModel || existing?.default_model || '').trim();
  const imported = await importProviderCatalog({ apiKey, baseURL, providerType: type, modelHint, allowModelValidation: !automatic });
  return {
    type,
    name: String(body.name || existing?.name || preset.name || 'Provedor').trim().slice(0, 80),
    apiKey,
    baseURL: imported.baseURL,
    models: imported.models,
    defaultModel: modelHint && imported.models.some(model => model.id === modelHint) ? modelHint : imported.models[0]?.id || '',
    validation: imported.validation,
    billingURL: optionalExternalURL(body.billing_url ?? existing?.billing_url ?? '')
  };
}

async function balanceFor(checked) {
  return fetchProviderBalance({ apiKey: checked.apiKey, baseURL: checked.baseURL, providerType: checked.type });
}

router.get('/providers', async (req, res) => {
  const providers = await Promise.all((await rowsFor(req.userId)).map(publicProvider));
  res.json({ providers });
});

router.post('/providers', async (req, res) => {
  try {
    const checked = await validateBody(req.body || {});
    const id = nanoid();
    const t = now();
    const balance = await balanceFor(checked);
    await db.prepare(`INSERT INTO user_ai_providers
      (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,last_validated_at,created_at,updated_at,billing_url,balance_info,balance_checked_at,last_sync_status,last_sync_error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, checked.type, checked.name, checked.baseURL, encryptSecret(checked.apiKey), JSON.stringify(checked.models), checked.defaultModel || null, t, t, t, checked.billingURL || null, JSON.stringify(balance), t, 'ok', null);
    res.status(201).json({ ok: true, provider: await publicProvider((await rowsFor(req.userId)).find(row => row.id === id)), imported: checked.models.length, validation: checked.validation });
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
    const balance = await balanceFor(checked);
    await db.prepare(`UPDATE user_ai_providers SET provider_type=?,name=?,base_url=?,api_key_enc=?,models=?,default_model=?,last_validated_at=?,updated_at=?,billing_url=?,balance_info=?,balance_checked_at=?,last_sync_status=?,last_sync_error=? WHERE id=? AND user_id=?`)
      .run(checked.type, checked.name, checked.baseURL, encryptSecret(checked.apiKey), JSON.stringify(checked.models), checked.defaultModel || null, t, t, checked.billingURL || null, JSON.stringify(balance), t, 'ok', null, existing.id, req.userId);
    res.json({ ok: true, imported: checked.models.length, validation: checked.validation });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || 'Não foi possível validar a chave.' });
  }
});

router.post('/providers/:id/refresh', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM user_ai_providers WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Provedor não encontrado.' });
  try {
    const automatic = req.body?.automatic === true;
    const checked = await validateBody({}, existing, { automatic });
    const t = now();
    const balance = await balanceFor(checked);
    await db.prepare('UPDATE user_ai_providers SET models=?,default_model=?,last_validated_at=?,updated_at=?,balance_info=?,balance_checked_at=?,last_sync_status=?,last_sync_error=? WHERE id=? AND user_id=?')
      .run(JSON.stringify(checked.models), checked.defaultModel || null, t, t, JSON.stringify(balance), t, 'ok', null, existing.id, req.userId);
    res.json({ ok: true, imported: checked.models.length });
  } catch (error) {
    await db.prepare('UPDATE user_ai_providers SET last_sync_status=?,last_sync_error=?,updated_at=? WHERE id=? AND user_id=?')
      .run('error', String(error?.message || '').slice(0, 300), now(), existing.id, req.userId).catch(() => {});
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
  const providers = await Promise.all((await rowsFor(req.userId)).map(publicProvider));
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
