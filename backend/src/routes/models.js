import { db } from '../db.js';
import { decryptSecret } from '../crypto.js';
import { enrichProviderCatalog } from '../providerCatalog.js';
import { registerModelCatalog } from '../modelCapabilities.js';
import { getUserProvider } from '../userProvider.js';
import { runProviderSync, runUserSync } from '../catalogSync.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

function parseCatalog(value) {
  try { const data = JSON.parse(value || '[]'); return Array.isArray(data) ? data : []; }
  catch { return []; }
}

// Catálogo de UM provedor cuja chave JÁ FOI decifrada pelo chamador. Quando o
// catálogo salvo venceu (ou não existe), a atualização passa pelo caminho
// único do catalogSync (mescla preservando + histórico) — antes esta rota
// gravava o catálogo cru da API por conta própria.
async function validatedCatalog(row) {
  const saved = parseCatalog(row.models);
  if (saved.length) {
    const lastSync = row.last_validated_at ? new Date(row.last_validated_at).getTime() : 0;
    if (lastSync && Date.now() - lastSync <= 12 * 60 * 60 * 1000) return enrichProviderCatalog(saved, row.provider_type);
    // Atualiza metadados vencidos sem fazer uma chamada paga de chat quando
    // o provedor não oferece GET /models (automatic=true). Em caso de falha, o
    // catálogo anterior continua disponível e o cartão mostra o erro.
    const synced = await runProviderSync(row, { automatic: true });
    return synced.ok ? enrichProviderCatalog(synced.models, row.provider_type) : enrichProviderCatalog(saved, row.provider_type);
  }
  // Credenciais migradas da configuração antiga ainda não tinham catálogo.
  // A primeira leitura valida a chave (inclusive por chat, se o provedor não
  // listar modelos) antes de importar e persistir.
  const synced = await runProviderSync(row, { automatic: false });
  return synced.ok ? enrichProviderCatalog(synced.models, row.provider_type) : [];
}

router.get('/models', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM user_ai_providers WHERE user_id=? ORDER BY created_at ASC').all(req.userId).catch(() => []);
  const models = [];
  // Provedor cuja chave não pode ser decifrada (removida, ou cifrada com outra
  // chave mestra depois de uma restauração) NÃO oferece modelos: escolher um
  // deles faria a mensagem cair em outro provedor/modo gratuito ou falhar. A
  // interface recebe a lista à parte para explicar e pedir o recadastro.
  const unavailableProviders = [];
  const usableRows = [];
  for (const row of rows) {
    if (decryptSecret(row.api_key_enc)) usableRows.push(row);
    else unavailableProviders.push({ id: row.id, name: row.name, providerType: row.provider_type, reason: 'key_unavailable' });
  }
  for (const row of usableRows) {
    const catalog = await validatedCatalog(row);
    models.push(...registerModelCatalog(catalog, {
      providerId: row.id,
      providerName: row.name,
      providerType: row.provider_type
    }));
  }

  // O modo gratuito continua disponível apenas após opt-in explícito — e
  // também quando os provedores cadastrados ficaram TODOS sem chave utilizável
  // (é o que getUserProvider faz nesse caso; a lista precisa dizer a verdade).
  if (!usableRows.length) {
    const free = await getUserProvider(req.userId, 'free::');
    if (free.source === 'free') {
      const freeModels = registerModelCatalog((free.freeModels || []).map(ref => {
        const raw = ref.slice('free::'.length);
        return { id: raw, name: `${raw.replace(/:free$/, '')} (grátis)`, free: true };
      }), { providerId: 'free', providerName: free.providerName || 'Modo gratuito', providerType: 'free' });
      return res.json({ models: freeModels, free: true, ...(unavailableProviders.length ? { unavailableProviders } : {}) });
    }
  }

  models.sort((a, b) => `${a.providerName} ${a.name}`.localeCompare(`${b.providerName} ${b.name}`));
  res.json({ models, ...(unavailableProviders.length ? { unavailableProviders } : {}) });
});

// Atualização MANUAL do catálogo (botão): sincroniza todos os provedores do
// usuário e devolve o relatório por provedor (adicionados, atualizados,
// removidos, incompletos, descontinuados, erros).
router.post('/models/sync', async (req, res) => {
  // O relatório não precisa do catálogo inteiro de cada provedor.
  const results = (await runUserSync(req.userId, { automatic: false })).map(({ models: _models, ...rest }) => rest);
  const totals = results.reduce((acc, r) => {
    if (!r.ok) { acc.errors += 1; return acc; }
    acc.added += r.counts?.added || 0;
    acc.changed += r.counts?.changed || 0;
    acc.removed += r.counts?.removed || 0;
    acc.needsReview += (r.counts?.incomplete || 0);
    return acc;
  }, { added: 0, changed: 0, removed: 0, needsReview: 0, errors: 0 });
  res.json({ ok: true, providers: results, totals });
});

// Histórico das mudanças automáticas do catálogo (antes/depois/fonte/data).
router.get('/models/history', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query?.limit, 10) || 100));
  const rows = await db.prepare(
    `SELECT provider_name, model_id, change_type, field, old_value, new_value, source, created_at
     FROM model_catalog_history WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(req.userId, limit).catch(() => []);
  res.json({ history: rows });
});

export default router;
