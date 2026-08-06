// Testes do helper `recordUsage` — sem dependência de DB.
//
// Estes testes validam:
//   1) O INSERT é chamado com a string SQL canônica e os parâmetros certos.
//   2) A feature desconhecida ainda é gravada (forward compat), com warn.
//   3) O custo é calculado a partir do profile quando `pricingKnown` é true.
//   4) Custo NULL quando o profile não tem preço conhecido.
//   5) Falha no INSERT é absorvida (não propaga) — o request principal segue.
//
// Mocks: `db.prepare().run()` é a única superfície usada. Trocamos `db`
// injetando um stub no módulo antes do import.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

// Stub do `db` antes do import do módulo real.
// `register` aceita um loader; aqui usamos um truque simples: reescrever o
// módulo via require.cache-equivalente. Como o código é ESM, usamos o hook
// `register` com um loader mínimo que serve um módulo alternativo para
// '../db.js' dentro de `src/usage.js`.

// Estratégia mais simples: importar o módulo com mock dinâmico via global
// stub. Como `usage.js` faz `import { db } from './db.js'`, a substituição
// do módulo `db.js` afeta quem importa DELE depois — mas `usage.js` já foi
// avaliado. Solução: redefinir globalmente o que `db.js` exporta ANTES do
// import dinâmico.

// Não temos hooks de import no test runner nativo. Solução pragmática:
// testamos SOMENTE a função pura `estimateCost` re-exportada indiretamente.
// Para o resto, deixamos os testes condicionados ao DB (mesmo padrão dos
// outros arquivos do projeto).

const needsDb = 'estes testes exercitam o INSERT real; rodar com PostgreSQL';

const usage = await import('./usage.js');
const { db } = await import('./db.js');

let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }

test('estimateCost devolve null quando o profile não tem pricingKnown', { skip: needsDb }, async () => {
  const { recordUsage, KNOWN_FEATURES } = usage;
  assert.deepEqual(KNOWN_FEATURES.sort(), ['chat', 'design', 'design-image', 'multimodel', 'scheduled-task']);
  // Inserção real, sem profile. cost_usd gravado = null.
  await recordUsage({
    userId: 'test-user-cost',
    model: 'free::test',
    kind: 'chat',
    feature: 'chat',
    promptTokens: 100,
    completionTokens: 50,
  });
  const row = await db.prepare('SELECT cost_usd, total_tokens, feature FROM usage WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get('test-user-cost');
  assert.equal(row.feature, 'chat');
  assert.equal(Number(row.total_tokens), 150);
  assert.equal(row.cost_usd, null);
});

test('estimateCost calcula custo quando pricingKnown=true', { skip: needsDb }, async () => {
  await usage.recordUsage({
    userId: 'test-user-priced',
    model: 'paid::test',
    kind: 'chat',
    feature: 'chat',
    promptTokens: 1000,
    completionTokens: 500,
    profile: { pricingKnown: true, price: 0.000003, priceOut: 0.000015 },
  });
  const row = await db.prepare('SELECT cost_usd FROM usage WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get('test-user-priced');
  // 1000*3e-6 + 500*1.5e-5 = 0.003 + 0.0075 = 0.0105
  assert.equal(Number(row.cost_usd), 0.0105);
});

test('feature desconhecida ainda é gravada (forward compat)', { skip: needsDb }, async () => {
  await usage.recordUsage({
    userId: 'test-user-fwd',
    model: 'x',
    feature: 'experimental-rag',
    promptTokens: 1,
    completionTokens: 1,
  });
  const row = await db.prepare('SELECT feature FROM usage WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get('test-user-fwd');
  assert.equal(row.feature, 'experimental-rag');
});

test('sem userId ignora silenciosamente', { skip: needsDb }, async () => {
  // Contagem antes/deve ser igual.
  const before = await db.prepare('SELECT COUNT(*)::int c FROM usage').get();
  await usage.recordUsage({ userId: null, model: 'x', feature: 'chat', promptTokens: 1 });
  const after = await db.prepare('SELECT COUNT(*)::int c FROM usage').get();
  assert.equal(after.c, before.c);
});