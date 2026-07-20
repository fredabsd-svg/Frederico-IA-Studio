// Cache genérico em memória: TTL + LRU, sem dependências externas.
//
// Um único módulo para TODAS as necessidades de cache do backend (embeddings,
// consultas de CNPJ, busca web, etc.). Cada cache criado se registra num
// catálogo central, que a rota /api/cache/stats expõe para observabilidade
// (taxa de acerto, tamanho, remoções). Assim dá para MEDIR se o cache está
// realmente economizando tokens/latência em produção.
//
// Escolhas de projeto:
//   * LRU por reinserção no Map (a ordem de inserção do Map é a ordem de uso);
//   * TTL por entrada, verificado na leitura (lazy expiration — sem timers);
//   * nunca guarda `undefined` (indistinguível de "ausente"), mas guarda `null`
//     normalmente caso o chamador queira cachear um resultado "vazio".

const registry = new Map();

export function createCache({ name, max = 500, ttl = 0 } = {}) {
  if (!name) throw new Error('createCache exige um "name" para o catálogo de estatísticas.');
  const store = new Map(); // key -> { value, expires }
  const stats = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0 };

  const isExpired = (entry) => entry.expires > 0 && Date.now() > entry.expires;

  function get(key) {
    const entry = store.get(key);
    if (entry === undefined) { stats.misses++; return undefined; }
    if (isExpired(entry)) { store.delete(key); stats.expirations++; stats.misses++; return undefined; }
    // LRU: reinsere para marcar como o mais recentemente usado.
    store.delete(key);
    store.set(key, entry);
    stats.hits++;
    return entry.value;
  }

  function has(key) {
    const entry = store.get(key);
    if (entry === undefined) return false;
    if (isExpired(entry)) { store.delete(key); stats.expirations++; return false; }
    return true;
  }

  function set(key, value, ttlOverride) {
    if (value === undefined) return value; // não cacheia "ausente"
    const t = ttlOverride ?? ttl;
    store.delete(key); // garante reinserção no fim (posição de mais recente)
    store.set(key, { value, expires: t > 0 ? Date.now() + t : 0 });
    stats.sets++;
    // LRU: remove o mais antigo (primeira chave do Map) enquanto estourar o teto.
    while (store.size > max) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
      stats.evictions++;
    }
    return value;
  }

  // Memoiza um produtor assíncrono: devolve o valor em cache ou calcula, guarda
  // e devolve. Só cacheia quando `shouldCache(value)` for verdadeiro (padrão:
  // sempre, exceto `undefined`), útil para não cachear erros transitórios.
  async function wrap(key, producer, { ttl: ttlOverride, shouldCache } = {}) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    const value = await producer();
    if (value !== undefined && (!shouldCache || shouldCache(value))) set(key, value, ttlOverride);
    return value;
  }

  const cache = {
    name, get, has, set, wrap,
    delete: (key) => store.delete(key),
    clear: () => store.clear(),
    get size() { return store.size; },
    snapshot() {
      const total = stats.hits + stats.misses;
      return {
        name,
        size: store.size,
        max,
        ttlMs: ttl,
        ...stats,
        hitRate: total ? Number((stats.hits / total).toFixed(3)) : 0
      };
    }
  };
  registry.set(name, cache);
  return cache;
}

// Estatísticas de todos os caches registrados (para /api/cache/stats).
export function cacheStats() {
  return [...registry.values()].map((c) => c.snapshot());
}

// Limpa todos os caches (usado em testes para garantir isolamento).
export function clearAllCaches() {
  for (const c of registry.values()) c.clear();
}
