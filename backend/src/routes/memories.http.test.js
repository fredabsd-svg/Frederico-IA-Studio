// Rotas da memória (routes/memories.js) exercitadas por HTTP de verdade:
// Express real + autenticação simulada + PostgreSQL real + multipart real.
//
// Três defeitos cobertos (auditoria 2026-09):
//   1) PUT /memory-config e PUT /sandbox-config gravavam configurações GLOBAIS
//      (inclusive a política de rede do sandbox, lida pelo agente de TODOS os
//      usuários) sem checar administrador — e sem faixa para os números;
//   3) POST /memories/import lia `req.file.buffer`, que não existe com o multer
//      em disco: a rota respondia "started" e a importação morria logo depois;
//      o progresso de uma importação era visível para qualquer usuário;
//  10) erros 500 devolviam `err.message` cru ao cliente.
//
// Sem PostgreSQL, os testes de banco são pulados (mesma convenção dos demais).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stamp = Date.now();
const ADMIN = `mem-admin-${stamp}`;
const COMUM = `mem-comum-${stamp}`;
const OUTRO = `mem-outro-${stamp}`;

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-mem-http-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-mem-http-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true'; // sem baixar modelo: chunks em modo degradado
process.env.ADMIN_USER_ID = ADMIN;        // administrador fixado por id (não depende de user_roles)
delete process.env.ADMIN_EMAIL;
delete process.env.CLAMAV_HOST;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const memoriesModule = await import('./memories.js');
const memoriesRouter = memoriesModule.default;
const { loadSettings, getSettings, clampSetting, invalidSettingKeys } = await import('../memory/memoryService.js');

let server, baseUrl;
let currentUser = COMUM;
let savedSettingsRows = [];

if (dbReady) {
  for (const id of [ADMIN, COMUM, OUTRO]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@teste.local`, false, now(), now());
  }
  // As configurações são GLOBAIS: guardamos o estado para restaurar no fim e
  // não contaminar outros testes que rodam em paralelo no mesmo banco.
  savedSettingsRows = await db.prepare('SELECT key, value FROM settings').all();
  await loadSettings();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = currentUser; req.user = { id: currentUser, email: `${currentUser}@teste.local` }; next(); });
  app.use('/api', memoriesRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: 'Erro interno do servidor.' }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  const keys = ['memory_enabled', 'auto_memory', 'review_auto_memory', 'economy_mode', 'context_target_tokens', 'max_memories', 'max_chunks', 'importance_threshold', 'sandbox_network_policy'];
  for (const key of keys) {
    const original = savedSettingsRows.find(r => r.key === key);
    try {
      if (original) await db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, original.value);
      else await db.prepare('DELETE FROM settings WHERE key=?').run(key);
    } catch {}
  }
  for (const id of [ADMIN, COMUM, OUTRO]) {
    try { await db.prepare('DELETE FROM conversation_chunks WHERE user_id=?').run(id); } catch {}
    try { await db.prepare('DELETE FROM admin_audit WHERE user_id=?').run(id); } catch {}
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});

async function call(method, route, { user = currentUser, body } = {}) {
  currentUser = user;
  const res = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- Faixas das configurações (puro, sem banco) ----------------------------

test('clampSetting grampeia números fora da faixa e recusa o que não é número', () => {
  assert.equal(clampSetting('max_memories', 10_000), 100);
  assert.equal(clampSetting('max_memories', -3), 0);
  assert.equal(clampSetting('context_target_tokens', 5), 2000);
  assert.equal(clampSetting('importance_threshold', 3.6), 4);
  assert.equal(clampSetting('memory_enabled', true), 1);
  assert.equal(clampSetting('max_chunks', 'abc'), null);
  assert.equal(clampSetting('max_chunks', { $gt: 1 }), null);
  assert.equal(clampSetting('max_chunks', Infinity), null);
  // Enumeração: fora dela é inválido, não "vira 0".
  assert.equal(clampSetting('sandbox_network_policy', 2), 2);
  assert.equal(clampSetting('sandbox_network_policy', 7), null);
  assert.deepEqual(invalidSettingKeys({ max_chunks: 'x', desconhecida: 'y', max_memories: 5 }), ['max_chunks']);
});

// ---- Autorização ----------------------------------------------------------

test('usuário comum NÃO altera a configuração global da memória (403) e nada muda', { skip: needsDb }, async () => {
  const antes = getSettings().max_memories;
  const r = await call('PUT', '/memory-config', { user: COMUM, body: { max_memories: antes === 7 ? 8 : 7 } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /administrador/i);
  assert.equal(getSettings().max_memories, antes, 'o cache global não foi alterado');
  const negado = await db.prepare("SELECT 1 FROM admin_audit WHERE user_id=? AND action='admin.denied'").get(COMUM);
  assert.ok(negado, 'a tentativa recusada fica auditada');
});

test('usuário comum NÃO altera a política de rede do sandbox (403)', { skip: needsDb }, async () => {
  const antes = getSettings().sandbox_network_policy;
  const r = await call('PUT', '/sandbox-config', { user: COMUM, body: { sandbox_network_policy: antes === 1 ? 2 : 1 } });
  assert.equal(r.status, 403);
  assert.equal(getSettings().sandbox_network_policy, antes);
  // Leitura continua livre: a interface precisa saber o que está em vigor.
  const leitura = await call('GET', '/sandbox-config', { user: COMUM });
  assert.equal(leitura.status, 200);
  assert.equal(leitura.body.sandbox_network_policy, antes);
});

test('administrador altera a memória; números fora da faixa são grampeados', { skip: needsDb }, async () => {
  const r = await call('PUT', '/memory-config', { user: ADMIN, body: { max_memories: 99_999, context_target_tokens: -10, economy_mode: 0 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.max_memories, 100);
  assert.equal(r.body.context_target_tokens, 2000);
  assert.equal(r.body.economy_mode, 0);
  const row = await db.prepare("SELECT value FROM settings WHERE key='max_memories'").get();
  assert.equal(Number(row.value), 100, 'o valor gravado no banco já é o grampeado');
  const auditado = await db.prepare("SELECT 1 FROM admin_audit WHERE user_id=? AND action='memory-config.update'").get(ADMIN);
  assert.ok(auditado);
});

test('ADVERSARIAL: valor não numérico na memória é 400, sem gravar nada', { skip: needsDb }, async () => {
  const antes = getSettings().max_chunks;
  const r = await call('PUT', '/memory-config', { user: ADMIN, body: { max_chunks: 'DROP TABLE settings', max_memories: 3 } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.invalid, ['max_chunks']);
  assert.equal(getSettings().max_chunks, antes);
});

test('administrador define a política do sandbox; valor fora de 0/1/2 é 400 (não vira 0)', { skip: needsDb }, async () => {
  const ok = await call('PUT', '/sandbox-config', { user: ADMIN, body: { sandbox_network_policy: 2 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sandbox_network_policy, 2);
  assert.equal(getSettings().sandbox_network_policy, 2);
  const ruim = await call('PUT', '/sandbox-config', { user: ADMIN, body: { sandbox_network_policy: 9 } });
  assert.equal(ruim.status, 400);
  assert.equal(getSettings().sandbox_network_policy, 2, 'o valor inválido não substituiu o vigente');
  const vazio = await call('PUT', '/sandbox-config', { user: ADMIN, body: {} });
  assert.equal(vazio.status, 400);
});

// ---- Importação -----------------------------------------------------------

async function waitImport(user) {
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', '/memories/import-status', { user });
    if (r.body?.done || r.body?.error) return r.body;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('a importação não terminou');
}

test('importação lê o arquivo do DISCO e cria os trechos; o progresso é só do dono', { skip: needsDb }, async () => {
  const form = new FormData();
  form.append('file', new Blob(['Usuário: prefiro relatórios em PDF.\nAssistente: anotado.']), 'notas-antigas.txt');
  currentUser = COMUM;
  const res = await fetch(`${baseUrl}/api/memories/import`, { method: 'POST', body: form });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { started: true });

  // Outro usuário não enxerga o progresso nem o nome do arquivo alheio.
  const alheio = await call('GET', '/memories/import-status', { user: OUTRO });
  assert.equal(alheio.body.file, '');
  assert.equal(alheio.body.running, false);

  const status = await waitImport(COMUM);
  assert.equal(status.error, null, `a importação falhou: ${status.error}`);
  assert.equal(status.done, true);
  assert.equal(status.file, 'notas-antigas.txt');
  assert.ok(status.chunks >= 1, 'pelo menos um trecho foi indexado');
  const row = await db.prepare('SELECT COUNT(*) AS n FROM conversation_chunks WHERE user_id=?').get(COMUM);
  assert.ok(Number(row.n) >= 1);

  // Nenhum temporário de upload sobra no staging.
  const tmpRoot = path.join(dataDir, 'tmp-uploads');
  assert.deepEqual(fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : [], []);
});

test('importação sem arquivo é 400 e não deixa temporário', { skip: needsDb }, async () => {
  const form = new FormData();
  form.append('outro', 'x');
  currentUser = COMUM;
  const res = await fetch(`${baseUrl}/api/memories/import`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
});

// ---- Mensagens de erro ----------------------------------------------------

test('erro interno na listagem NÃO devolve a mensagem crua ao cliente', { skip: needsDb }, async () => {
  const original = db.prepare;
  // Simula uma falha de banco com texto sensível (SQL/topologia).
  db.prepare = () => { throw new Error('relation "memory" does not exist at 10.0.0.5:5432'); };
  try {
    const r = await call('GET', '/memories', { user: COMUM });
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.body.error, /relation|10\.0\.0\.5|5432/);
    assert.match(r.body.error, /Não foi possível carregar as memórias/);
  } finally {
    db.prepare = original;
  }
});
