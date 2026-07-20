import assert from 'node:assert/strict';
import test from 'node:test';

const { createCache, cacheStats, clearAllCaches } = await import('./cache.js');

test('guarda e devolve valores; conta hits/misses', () => {
  const c = createCache({ name: 'test-basic', max: 10 });
  assert.equal(c.get('a'), undefined);      // miss
  c.set('a', 1);
  assert.equal(c.get('a'), 1);              // hit
  assert.equal(c.has('a'), true);
  const s = c.snapshot();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.sets, 1);
  assert.equal(s.size, 1);
});

test('nunca guarda undefined (indistinguível de ausente), mas guarda null', () => {
  const c = createCache({ name: 'test-undef', max: 10 });
  c.set('u', undefined);
  assert.equal(c.has('u'), false);
  c.set('n', null);
  assert.equal(c.has('n'), true);
  assert.equal(c.get('n'), null);
});

test('LRU: remove o menos usado ao estourar o teto', () => {
  const c = createCache({ name: 'test-lru', max: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');            // 'a' vira o mais recente; 'b' vira o mais antigo
  c.set('c', 3);         // estoura → remove 'b'
  assert.equal(c.has('a'), true);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('c'), true);
  assert.equal(c.snapshot().evictions, 1);
});

test('TTL: expira a entrada após o prazo', async () => {
  const c = createCache({ name: 'test-ttl', max: 10, ttl: 20 });
  c.set('x', 1);
  assert.equal(c.get('x'), 1);
  await new Promise(r => setTimeout(r, 35));
  assert.equal(c.get('x'), undefined);   // expirou
  assert.equal(c.snapshot().expirations >= 1, true);
});

test('wrap memoiza o produtor e respeita shouldCache', async () => {
  const c = createCache({ name: 'test-wrap', max: 10 });
  let calls = 0;
  const producer = async () => { calls++; return 42; };
  assert.equal(await c.wrap('k', producer), 42);
  assert.equal(await c.wrap('k', producer), 42);
  assert.equal(calls, 1);                // segunda vez veio do cache

  // shouldCache=false ⇒ nunca guarda (erros transitórios)
  let calls2 = 0;
  const err = async () => { calls2++; return { error: 'transitório' }; };
  await c.wrap('e', err, { shouldCache: v => !v.error });
  await c.wrap('e', err, { shouldCache: v => !v.error });
  assert.equal(calls2, 2);
});

test('cacheStats lista os caches registrados; clearAllCaches esvazia', () => {
  const c = createCache({ name: 'test-stats', max: 10 });
  c.set('a', 1);
  const stats = cacheStats();
  assert.equal(stats.some(s => s.name === 'test-stats'), true);
  clearAllCaches();
  assert.equal(c.size, 0);
});
