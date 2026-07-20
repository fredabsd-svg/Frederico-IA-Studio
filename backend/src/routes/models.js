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
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return res.json({ models: cached.models });
  try {
    const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${prov.apiKey || ''}` } });
    const data = await r.json();
    const models = registerModelCatalog(data.data || [])
      .sort((a, b) => a.name.localeCompare(b.name));
    modelsCache.set(cacheKey, { models, at: Date.now() });
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

export default router;
