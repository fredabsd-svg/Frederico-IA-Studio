import { db, now } from '../db.js';
import { decryptSecret } from '../crypto.js';
import { enrichProviderCatalog, importProviderCatalog } from '../providerCatalog.js';
import { registerModelCatalog } from '../modelCapabilities.js';
import { getUserProvider } from '../userProvider.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

function parseCatalog(value) {
  try { const data = JSON.parse(value || '[]'); return Array.isArray(data) ? data : []; }
  catch { return []; }
}

async function validatedCatalog(row) {
  const saved = parseCatalog(row.models);
  if (saved.length) {
    const lastSync = row.last_validated_at ? new Date(row.last_validated_at).getTime() : 0;
    if (lastSync && Date.now() - lastSync <= 12 * 60 * 60 * 1000) return enrichProviderCatalog(saved, row.provider_type);
    const apiKey = decryptSecret(row.api_key_enc);
    if (!apiKey) return enrichProviderCatalog(saved, row.provider_type);
    try {
      // Atualiza metadados vencidos sem fazer uma chamada paga de chat quando
      // o provedor não oferece GET /models. Em caso de falha, o catálogo
      // anterior continua disponível e o cartão mostra o erro de sincronização.
      const imported = await importProviderCatalog({
        apiKey, baseURL: row.base_url, providerType: row.provider_type,
        modelHint: row.default_model, allowModelValidation: false
      });
      const t = now();
      await db.prepare('UPDATE user_ai_providers SET models=?,last_validated_at=?,last_sync_status=?,last_sync_error=?,updated_at=? WHERE id=? AND user_id=?')
        .run(JSON.stringify(imported.models), t, 'ok', null, t, row.id, row.user_id);
      return imported.models;
    } catch (error) {
      await db.prepare('UPDATE user_ai_providers SET last_sync_status=?,last_sync_error=?,updated_at=? WHERE id=? AND user_id=?')
        .run('error', String(error?.message || '').slice(0, 300), now(), row.id, row.user_id).catch(() => {});
      return enrichProviderCatalog(saved, row.provider_type);
    }
  }
  // Credenciais migradas da configuração antiga ainda não tinham catálogo.
  // A primeira leitura valida a chave antes de importar e persistir os modelos.
  const apiKey = decryptSecret(row.api_key_enc);
  if (!apiKey) return [];
  try {
    const imported = await importProviderCatalog({
      apiKey, baseURL: row.base_url, providerType: row.provider_type, modelHint: row.default_model
    });
    await db.prepare('UPDATE user_ai_providers SET models=?, last_validated_at=?, updated_at=? WHERE id=? AND user_id=?')
      .run(JSON.stringify(imported.models), now(), now(), row.id, row.user_id);
    return imported.models;
  } catch {
    return [];
  }
}

router.get('/models', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM user_ai_providers WHERE user_id=? ORDER BY created_at ASC').all(req.userId).catch(() => []);
  const models = [];
  for (const row of rows) {
    const catalog = await validatedCatalog(row);
    models.push(...registerModelCatalog(catalog, {
      providerId: row.id,
      providerName: row.name,
      providerType: row.provider_type
    }));
  }

  // O modo gratuito continua disponível apenas após opt-in explícito.
  if (!rows.length) {
    const free = await getUserProvider(req.userId, 'free::');
    if (free.source === 'free') {
      const freeModels = registerModelCatalog((free.freeModels || []).map(ref => {
        const raw = ref.slice('free::'.length);
        return { id: raw, name: `${raw.replace(/:free$/, '')} (grátis)`, free: true };
      }), { providerId: 'free', providerName: free.providerName || 'Modo gratuito', providerType: 'free' });
      return res.json({ models: freeModels, free: true });
    }
  }

  models.sort((a, b) => `${a.providerName} ${a.name}`.localeCompare(`${b.providerName} ${b.name}`));
  res.json({ models });
});

export default router;
