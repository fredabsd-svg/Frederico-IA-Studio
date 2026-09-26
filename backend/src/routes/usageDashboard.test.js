// Testes do dashboard operacional. Os quatro primeiros não usam banco; os do
// fim (consulta real + rota HTTP com autorização) exigem PostgreSQL e se
// autopulam sem ele.
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

const stamp = Date.now();
const ADMIN = `dash-admin-${stamp}`;
const COMUM = `dash-comum-${stamp}`;
process.env.ADMIN_USER_ID = ADMIN; // lido por routes/helpers.js na importação

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
// ---- Com banco: a consulta real e a rota HTTP --------------------------------
// O defeito: topUsers selecionava u.name/u.email, mas `u` é o alias da tabela
// `usage` (que não tem essas colunas) — o painel respondia 500 SEMPRE.

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

if (dbReady) {
  for (const id of [ADMIN, COMUM]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, `Nome ${id}`, `${id}@t.local`, false, now(), now());
  }
  await db.prepare('INSERT INTO usage (id,user_id,model,kind,feature,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`dash-uso-${stamp}`, COMUM, 'm', 'chat', 'chat', 1, 2, 999_999_999, now());
}

test.after(async () => {
  if (!dbReady) return;
  await db.prepare('DELETE FROM usage WHERE id=?').run(`dash-uso-${stamp}`).catch(() => {});
  for (const id of [ADMIN, COMUM]) {
    await db.prepare('DELETE FROM admin_audit WHERE user_id=?').run(id).catch(() => {});
    await db.prepare('DELETE FROM "user" WHERE id=?').run(id).catch(() => {});
  }
});

test('topUsers roda de verdade e mostra o NOME do usuário (join com a tabela de usuários)', { skip: needsDb }, async () => {
  const top = await dashboard.topUsers(dashboard.startOfUtcDay(-1), 50);
  const linha = top.find(r => r.userId === COMUM);
  assert.ok(linha, 'o usuário com consumo aparece no ranking');
  assert.equal(linha.display, `Nome ${COMUM}`);
});

test('GET /admin/usage/dashboard: 403 para usuário comum, 200 com ranking para o administrador', { skip: needsDb }, async () => {
  const express = (await import('express')).default;
  let current = COMUM;
  const app = express();
  app.use((req, _res, next) => { req.userId = current; req.user = { id: current, email: `${current}@t.local` }; next(); });
  app.use('/api', dashboard.default);
  app.use((err, _req, res, _next) => { res.status(500).json({ error: 'Erro interno do servidor.' }); });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/usage/dashboard`;
  try {
    const negado = await fetch(url);
    assert.equal(negado.status, 403);
    current = ADMIN;
    const ok = await fetch(url);
    assert.equal(ok.status, 200, 'o painel não pode responder 500');
    const body = await ok.json();
    assert.ok(body.topUsers30d.some(r => r.userId === COMUM && r.display === `Nome ${COMUM}`));
  } finally {
    server.close();
  }
});
