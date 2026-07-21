// Rotas de models — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { registerModelCatalog } from '../modelCapabilities.js';
import { getUserProvider } from '../userProvider.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

// Lista os modelos disponíveis no provedor configurado (ex.: catálogo do
// OpenRouter). Marca quais suportam "tools" (necessário p/ gerar arquivos).
//
// IMPORTANTE (BYOK): o catálogo é buscado no provedor DO USUÁRIO — a mesma
// base_url e a mesma chave que ele usa para conversar (getUserProvider). Antes
// isto usava sempre o .env do servidor; então um usuário com chave própria do
// OpenRouter via só o catálogo do servidor (às vezes o DeepSeek, com pouquíssimos
// modelos) — daí "modelos do OpenRouter que não aparecem no app". Agora cada um
// vê o catálogo do próprio provedor.
const CACHE_TTL_MS = 10 * 60 * 1000;
const modelsCache = new Map(); // chave (usuário BYOK ou base compartilhada) -> { models, at }

router.get('/models', async (req, res) => {
  const prov = await getUserProvider(req.userId);
  const base = String(prov.baseURL || 'https://api.deepseek.com').replace(/\/$/, '');
  // Usuário com chave própria tem cache isolado (o catálogo pode variar por
  // conta); quem usa a chave compartilhada do servidor compartilha por base.
  const cacheKey = prov.source === 'user' ? `u:${req.userId}` : `s:${base}`;
  const cached = modelsCache.get(cacheKey);
  if (!cached || Date.now() - cached.at >= CACHE_TTL_MS) {
    try {
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${prov.apiKey || ''}` } });
      const data = await r.json();
      const models = registerModelCatalog(data.data || [])
        .sort((a, b) => a.name.localeCompare(b.name));
      modelsCache.set(cacheKey, { models, at: Date.now() });
    } catch (err) {
      if (prov.source !== 'free') return res.json({ models: [], error: err.message });
      modelsCache.set(cacheKey, { models: [], at: Date.now() - CACHE_TTL_MS + 60_000 }); // tenta de novo em 1 min
    }
  }
  const catalog = modelsCache.get(cacheKey)?.models || [];
  // MODO GRATUITO: o seletor só oferece a allowlist gratuita — os metadados
  // (nome/capacidades) vêm do catálogo do provedor quando disponíveis.
  if (prov.source === 'free') {
    const byId = new Map(catalog.map(m => [m.id, m]));
    const models = (prov.freeModels || []).map(id => byId.get(id) || {
      id, name: id.replace(/:free$/, '') + ' (grátis)', tools: true, vision: false, image: false, video: false, reasoning: false,
      capabilities: { text: true, tools: true, vision: false, image: false, video: false, reasoning: false }
    });
    return res.json({ models, free: true });
  }
  res.json({ models: catalog });
});

export default router;
