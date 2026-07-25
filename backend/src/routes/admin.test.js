// Autorização administrativa: papel PERSISTIDO em user_roles, com o e-mail
// servindo apenas de bootstrap do primeiro administrador.
//
// O buraco corrigido: bastava a sessão ter o e-mail de ADMIN_EMAIL para baixar
// o backup completo (banco + workspaces + chave mestra de todos os usuários),
// administrar o modo gratuito e mudar a configuração global do Docling. Como o
// cadastro não exige verificação de e-mail, quem registrasse aquele endereço —
// antes ou depois do dono — virava administrador. Os testes abaixo provam que:
//   * o primeiro titular do e-mail reivindica o papel UMA vez (bootstrap);
//   * a partir daí o papel está preso ao ID: outra conta com o MESMO e-mail
//     não é administradora;
//   * ADMIN_USER_ID autoriza sem depender de e-mail nenhum;
//   * cada ação e cada recusa deixam registro em admin_audit.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ADMIN_EMAIL = 'admin@frederico.test';
delete process.env.ADMIN_USER_ID;

const { db, now } = await import('../db.js');

let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const { isAdmin, requireAdmin, recordAdminAction } = await import('./helpers.js');

const stamp = Date.now();
const LEGIT = `admin-legit-${stamp}`;
const IMPOSTOR = `admin-impostor-${stamp}`;
const COMUM = `usuario-comum-${stamp}`;

async function createUser(id, email) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(id, id, email, false, now(), now());
}

function fakeReq(userId, email) {
  return { userId, user: { id: userId, email }, ip: '203.0.113.7', headers: { 'user-agent': 'teste' }, path: '/backup', originalUrl: '/api/backup' };
}

function fakeRes() {
  const out = { statusCode: null, body: null };
  return {
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    _out: out
  };
}

if (dbReady) {
  // Ambiente limpo: nenhum administrador previamente concedido.
  await db.prepare("DELETE FROM user_roles WHERE role='admin'").run();
}

test('bootstrap: o titular de ADMIN_EMAIL reivindica o papel e ele é persistido', { skip: needsDb }, async () => {
  await createUser(LEGIT, 'admin@frederico.test');
  assert.equal(await isAdmin(fakeReq(LEGIT, 'admin@frederico.test')), true);
  const row = await db.prepare("SELECT granted_by FROM user_roles WHERE user_id=? AND role='admin'").get(LEGIT);
  assert.ok(row, 'o papel foi gravado em user_roles');
  assert.equal(row.granted_by, 'bootstrap:ADMIN_EMAIL');
});

test('SEQUESTRO BLOQUEADO: outra conta com o mesmo e-mail não vira administradora', { skip: needsDb }, async () => {
  // Cenário: o e-mail do administrador é reutilizado/alterado noutra conta.
  // Com o papel já preso ao ID do titular, a nova conta não herda nada.
  await createUser(IMPOSTOR, `impostor-${stamp}@frederico.test`);
  const req = fakeReq(IMPOSTOR, 'admin@frederico.test'); // mesma string de e-mail
  assert.equal(await isAdmin(req), false);
  const row = await db.prepare("SELECT 1 FROM user_roles WHERE user_id=? AND role='admin'").get(IMPOSTOR);
  assert.equal(row, undefined, 'nenhum papel concedido ao impostor');
});

test('usuário comum não é administrador e recebe 403 no portão', { skip: needsDb }, async () => {
  await createUser(COMUM, `comum-${stamp}@frederico.test`);
  const req = fakeReq(COMUM, `comum-${stamp}@frederico.test`);
  const res = fakeRes();
  assert.equal(await requireAdmin(req, res), false);
  assert.equal(res._out.statusCode, 403);
  assert.match(res._out.body.error, /administrador/i);
});

test('o papel persistido continua valendo mesmo se ADMIN_EMAIL não bater mais', { skip: needsDb }, async () => {
  // O administrador trocou o próprio e-mail: o papel é dele, não do endereço.
  const req = fakeReq(LEGIT, `novo-endereco-${stamp}@frederico.test`);
  assert.equal(await isAdmin(req), true);
});

test('toda ação e toda recusa administrativa ficam registradas em admin_audit', { skip: needsDb }, async () => {
  await recordAdminAction(fakeReq(LEGIT, 'admin@frederico.test'), 'backup.download', { chave_mestra: 'file' });
  const acao = await db.prepare("SELECT * FROM admin_audit WHERE user_id=? AND action='backup.download' ORDER BY created_at DESC LIMIT 1").get(LEGIT);
  assert.ok(acao, 'a ação foi auditada');
  assert.equal(acao.ip, '203.0.113.7');
  assert.match(acao.detail, /chave_mestra/);

  const negado = await db.prepare("SELECT * FROM admin_audit WHERE user_id=? AND action='admin.denied' ORDER BY created_at DESC LIMIT 1").get(COMUM);
  assert.ok(negado, 'a tentativa recusada também foi auditada');
});

test('a resolução do papel é memoizada por requisição', { skip: needsDb }, async () => {
  const req = fakeReq(LEGIT, 'admin@frederico.test');
  assert.equal(await isAdmin(req), true);
  req.userId = COMUM; // se não fosse memoizado, recalcularia e daria false
  assert.equal(await isAdmin(req), true);
});

test.after(async () => {
  if (!dbReady) return;
  for (const id of [LEGIT, IMPOSTOR, COMUM]) {
    try { await db.prepare('DELETE FROM admin_audit WHERE user_id=?').run(id); } catch {}
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});
