// Observabilidade dos caches em memória do backend. Somente leitura: expõe
// tamanho, TTL e taxa de acerto de cada cache (embeddings, CNPJ, busca web,
// prompt caching é medido via usage.cached_tokens nas respostas). Útil para
// confirmar que o cache está de fato economizando tokens/latência.
import { makeRouter } from './helpers.js';
import { cacheStats } from '../cache.js';

const router = makeRouter();

router.get('/cache/stats', (_req, res) => {
  res.json({ caches: cacheStats() });
});

export default router;
