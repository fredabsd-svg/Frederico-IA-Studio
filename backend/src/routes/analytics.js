// Rotas de analytics — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { db } from '../db.js';
import { modelProfileFromProvider } from '../modelCapabilities.js';
import { enrichProviderCatalog } from '../providerCatalog.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

function catalogMap(providers) {
  const map = new Map();
  for (const provider of providers) {
    let models = [];
    try { models = JSON.parse(provider.models || '[]'); } catch {}
    for (const model of enrichProviderCatalog(models, provider.provider_type)) {
      map.set(`${provider.id}::${model.id}`, {
        ...modelProfileFromProvider(model),
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.provider_type,
        providerModelId: model.id
      });
    }
  }
  return map;
}

function usageEstimate(row, profiles) {
  const profile = profiles.get(row.model);
  const estimatedCost = profile?.pricingKnown
    ? Number(row.prompt_tokens || 0) * Number(profile.price || 0) + Number(row.completion_tokens || 0) * Number(profile.priceOut || 0)
    : null;
  return {
    ...row,
    providerId: profile?.providerId || '',
    providerName: profile?.providerName || (String(row.model || '').startsWith('free::') ? 'Modo gratuito' : 'Não identificado'),
    modelName: profile?.name || String(row.model || '').split('::').at(-1),
    free: profile?.free === true,
    estimatedCost
  };
}

function grouped(rows, keyFn, labelFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const entry = groups.get(key) || { key, name: labelFn(row), messages: 0, prompt_tokens: 0, completion_tokens: 0, tokens: 0, estimatedCost: 0, pricedMessages: 0 };
    entry.messages += 1;
    entry.prompt_tokens += Number(row.prompt_tokens || 0);
    entry.completion_tokens += Number(row.completion_tokens || 0);
    entry.tokens += Number(row.total_tokens || 0);
    if (row.estimatedCost != null) { entry.estimatedCost += row.estimatedCost; entry.pricedMessages += 1; }
    groups.set(key, entry);
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
}

// ---- Analytics de uso (mensagens e tokens) ----
router.get('/analytics', async (req, res) => {
  const providers = await db.prepare('SELECT id,name,provider_type,models FROM user_ai_providers WHERE user_id=?').all(req.userId).catch(() => []);
  const profiles = catalogMap(providers);
  const rawUsage = await db.prepare('SELECT model,conversation_id,prompt_tokens,completion_tokens,total_tokens,created_at FROM usage WHERE user_id=?').all(req.userId);
  const detailed = rawUsage.map(row => usageEstimate(row, profiles));
  const totals = await db.prepare('SELECT COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens FROM usage WHERE user_id=?').get(req.userId);
  totals.messages = Number(totals.messages);
  totals.tokens = Number(totals.tokens);
  totals.prompt_tokens = Number(totals.prompt_tokens);
  totals.completion_tokens = Number(totals.completion_tokens);
  const byAssistant = (await db.prepare(`
    SELECT COALESCE(a.name,'(sem assistente / equipe)') name, a.emoji,
           COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN assistants a ON a.id=u.assistant_id
    WHERE u.user_id=?
    GROUP BY u.assistant_id, a.name, a.emoji ORDER BY tokens DESC`).all(req.userId))
    .map(r => ({ ...r, messages: Number(r.messages), tokens: Number(r.tokens) }));
  const byModel = grouped(detailed, row => row.model, row => row.modelName)
    .map(row => ({ ...row, model: row.name, providerName: detailed.find(item => item.model === row.key)?.providerName || '' }));
  const byProvider = grouped(detailed, row => row.providerId || row.providerName, row => row.providerName);
  const byDay = grouped(detailed, row => String(row.created_at || '').slice(0, 10), row => String(row.created_at || '').slice(0, 10))
    .sort((a, b) => String(b.key).localeCompare(String(a.key))).slice(0, 31);
  const byMonth = grouped(detailed, row => String(row.created_at || '').slice(0, 7), row => String(row.created_at || '').slice(0, 7))
    .sort((a, b) => String(b.key).localeCompare(String(a.key))).slice(0, 12);
  const conversationEstimates = new Map(grouped(detailed, row => row.conversation_id || '', () => '').map(row => [row.key, row]));
  const byConversation = (await db.prepare(`
    SELECT u.conversation_id id, COALESCE(c.title,'(conversa apagada)') title, COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN conversations c ON c.id=u.conversation_id
    WHERE u.user_id=?
    GROUP BY u.conversation_id, c.title ORDER BY tokens DESC LIMIT 15`).all(req.userId))
    .map(r => ({
      ...r, messages: Number(r.messages), tokens: Number(r.tokens),
      estimatedCost: conversationEstimates.get(r.id)?.estimatedCost || 0,
      pricedMessages: conversationEstimates.get(r.id)?.pricedMessages || 0
    }));
  totals.estimatedCost = detailed.reduce((sum, row) => sum + Number(row.estimatedCost || 0), 0);
  totals.pricedMessages = detailed.filter(row => row.estimatedCost != null).length;
  totals.freeMessages = detailed.filter(row => row.free).length;
  totals.paidMessages = detailed.filter(row => row.estimatedCost != null && !row.free).length;
  res.json({ totals, byAssistant, byProvider, byModel, byConversation, byDay, byMonth });
});

export default router;
