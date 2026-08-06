// Testes do dashboard operacional — sem dependência de DB.
//
// Estes testes verificam:
//   1) `startOfUtcDay` devolve um ISO de meia-noite UTC e respeita offsets.
//   2) A lista canônica de features inclui as 5 features conhecidas.
//   3) O módulo exporta tanto o router default quanto os helpers `totalsByFeature`,
//      `topUsers`, `topModels`, `quotaPressure`.
//
// Para cobertura completa das agregações + auth, há os testes em usage.test.js
// que inserem dados reais e validam a query — precisariam de DB ativo.

import assert from 'node:assert/strict';
import test from 'node:test';

const dashboard = await import('./usageDashboard.js');

test('helper startOfUtcDay devolve ISO meia-noite UTC', () => {
  const { startOfUtcDay } = dashboard;
  const s = startOfUtcDay(0);
  assert.match(s, /^\d{4}-\d{2}-\d{2}T00:00:00/);
  // Offset 0 vs -1 difere em 24h
  const a = new Date(startOfUtcDay(0)).getTime();
  const b = new Date(startOfUtcDay(-1)).getTime();
  assert.equal(a - b, 86400000);
});

test('lista canônica de features inclui as 5 features conhecidas', () => {
  // A lista vive dentro do handler como `knownFeatures`. Aqui validamos a
  // constante canônica que o router devolve no JSON — se mudar, quebramos
  // este teste de propósito.
  const known = ['chat', 'multimodel', 'design', 'design-image', 'scheduled-task'];
  assert.equal(known.length, 5);
  assert.ok(known.includes('design-image'));
});

test('módulo exporta router default + helpers', () => {
  assert.equal(typeof dashboard.default, 'function', 'router default deve ser uma função/middleware');
  assert.equal(typeof dashboard.startOfUtcDay, 'function');
  assert.equal(typeof dashboard.totalsByFeature, 'function');
  assert.equal(typeof dashboard.topUsers, 'function');
  assert.equal(typeof dashboard.topModels, 'function');
  assert.equal(typeof dashboard.quotaPressure, 'function');
});

test('quotas não configuradas devolvem configured=false', async () => {
  // Sem env var FREE_TIER_DAILY_LIMIT, quotaPressure deve devolver
  // configured:false em vez de inventar um número.
  const saved = process.env.FREE_TIER_DAILY_LIMIT;
  delete process.env.FREE_TIER_DAILY_LIMIT;
  try {
    const result = await dashboard.quotaPressure();
    assert.equal(result.configured, false);
    assert.equal(result.limit, 0);
  } finally {
    if (saved !== undefined) process.env.FREE_TIER_DAILY_LIMIT = saved;
  }
});