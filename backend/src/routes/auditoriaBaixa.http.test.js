// Itens de severidade BAIXA da auditoria 2026-09, por HTTP de verdade:
//   13) devProjects: permissões acima do teto derrubavam a rota com 500 (o JSON
//       serializado era cortado no meio e o JSON.parse lançava);
//   14) painel do modo gratuito: limite inválido virava 1 em silêncio (a
//       checagem de inválido era código morto) e o "hoje" do painel era o dia
//       UTC, não o dia do fuso do app em que o consumo foi gravado;
//   15) aceite dos Termos gravava como evidência o IP escrito pelo CLIENTE
//       (primeiro item do X-Forwarded-For);
//   17) download de artefato do Docling sem ouvinte de 'error' — uma falha de
//       leitura derrubava o processo inteiro.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stamp = Date.now();
const ADMIN = `baixa-admin-${stamp}`;
const COMUM = `baixa-comum-${stamp}`;
process.env.ADMIN_USER_ID = ADMIN;
// Fuso escolhido para que o "hoje" do app seja OUTRO dia que o de UTC agora —
// é exatamente a janela em que o painel antigo mostrava o dia errado.
process.env.APP_TIMEZONE = new Date().getUTCHours() >= 12 ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-baixa-'));
process.env.DATA_DIR = scratch;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const devProjectsModule = await import('./devProjects.js');
const freeTierRoutes = await import('./freeTier.js');
const accountRouter = (await import('./account.js')).default;
const { freeTierDayKey } = await import('../freeTier.js');
const { streamFileToResponse } = await import('./helpers.js');

let currentUser = COMUM;
const app = express();
app.set('trust proxy', 1); // igual ao server.js
app.use(express.json());
app.use((req, _res, next) => { req.userId = currentUser; req.user = { id: currentUser, email: `${currentUser}@t.local` }; next(); });
app.use('/api', devProjectsModule.default);
app.use('/api', freeTierRoutes.default);
app.use('/api', accountRouter);
app.get('/arquivo', (req, res) => streamFileToResponse(res, String(req.query.p), 'application/json'));
app.use((err, _req, res, _next) => { res.status(500).json({ error: 'Erro interno do servidor.' }); });
const server = app.listen(0);
await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

if (dbReady) {
  for (const id of [ADMIN, COMUM]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@t.local`, false, now(), now());
  }
}

test.after(async () => {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  if (!dbReady) return;
  for (const id of [ADMIN, COMUM]) {
    for (const table of ['user_consents', 'free_tier_usage', 'free_tier_user_limits', 'user_settings', 'admin_audit']) {
      await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id).catch(() => {});
    }
    await db.prepare('DELETE FROM "user" WHERE id=?').run(id).catch(() => {});
  }
});

async function call(method, route, { body, user = currentUser, headers = {} } = {}) {
  currentUser = user;
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- 13) devProjects -------------------------------------------------------

test('permissões acima do teto: sanitize devolve erro (não lança) e a rota responde 400', async () => {
  const enorme = { comandos: 'x'.repeat(25_000) };
  const r = devProjectsModule.sanitizeProjectInput({ id: 'proj-1', name: 'Projeto', permissions: enorme });
  assert.match(r.error, /limite/);
  const http = await call('PUT', '/api/dev-projects/proj-1', { body: { name: 'Projeto', permissions: enorme } });
  assert.equal(http.status, 400, 'antes: JSON.parse de um JSON cortado → 500');
  assert.match(http.body.error, /permissões/);
  // Dentro do teto, as permissões passam intactas.
  const ok = devProjectsModule.sanitizeProjectInput({ id: 'proj-1', name: 'Projeto', permissions: { push: true } });
  assert.deepEqual(ok.project.permissions, { push: true });
});

// ---- 14) painel do modo gratuito ---------------------------------------------

test('parseDailyLimit aceita só inteiros de 1 a 10.000', () => {
  for (const ruim of ['abc', 0, -5, 1.5, 10_001, '', null, undefined, true, {}, []]) {
    assert.equal(freeTierRoutes.parseDailyLimit(ruim), null, `deveria recusar ${JSON.stringify(ruim)}`);
  }
  assert.equal(freeTierRoutes.parseDailyLimit('20'), 20);
  assert.equal(freeTierRoutes.parseDailyLimit(10_000), 10_000);
});

test('limite inválido no painel é 400 — não vira 1 em silêncio, nem grava metade', { skip: needsDb }, async () => {
  // free_tier_settings é GLOBAL: o estado é restaurado no fim mesmo que o
  // teste falhe (uma regressão aqui não pode desligar o modo gratuito dos
  // outros testes que rodam em paralelo no mesmo banco).
  const antes = await db.prepare("SELECT key, value FROM free_tier_settings WHERE key IN ('enabled','msgs_per_day') ORDER BY key").all();
  try {
    const r = await call('PUT', '/api/admin/free-tier/settings', { user: ADMIN, body: { enabled: false, msgsPerDay: 'abc' } });
    assert.equal(r.status, 400);
    const depois = await db.prepare("SELECT key, value FROM free_tier_settings WHERE key IN ('enabled','msgs_per_day') ORDER BY key").all();
    assert.deepEqual(depois, antes, 'nenhuma chave foi gravada');
  } finally {
    await db.prepare("DELETE FROM free_tier_settings WHERE key IN ('enabled','msgs_per_day')").run();
    for (const row of antes) await db.prepare('INSERT INTO free_tier_settings (key, value) VALUES (?,?)').run(row.key, row.value);
  }

  const lim = await call('PUT', '/api/admin/free-tier/user-limit', { user: ADMIN, body: { userId: COMUM, msgsPerDay: 0 } });
  assert.equal(lim.status, 400, 'antes: 0 virava limite 1');
  const row = await db.prepare('SELECT msgs_per_day FROM free_tier_user_limits WHERE user_id=?').get(COMUM);
  assert.equal(row, undefined);
  const valido = await call('PUT', '/api/admin/free-tier/user-limit', { user: ADMIN, body: { userId: COMUM, msgsPerDay: '7' } });
  assert.equal(valido.status, 200);
  assert.equal(valido.body.msgsPerDay, 7);
});

test('o "hoje" do painel é o dia do FUSO DO APP, o mesmo em que o consumo foi gravado', { skip: needsDb }, async () => {
  const hojeApp = freeTierDayKey();
  assert.notEqual(hojeApp, new Date().toISOString().slice(0, 10), 'pré-condição: o fuso escolhido está em outro dia');
  await db.prepare('INSERT INTO user_settings (user_id, free_mode, created_at, updated_at) VALUES (?,?,?,?)').run(COMUM, 1, now(), now());
  await db.prepare('INSERT INTO free_tier_usage (user_id, day, msgs, tokens) VALUES (?,?,?,?)').run(COMUM, hojeApp, 3, 42);
  const r = await call('GET', '/api/admin/free-tier', { user: ADMIN });
  assert.equal(r.status, 200);
  const linha = r.body.users.find(u => u.id === COMUM);
  assert.equal(linha?.msgs_hoje, 3);
  assert.equal(linha?.tokens_hoje, 42);
});

// ---- 15) IP do aceite ------------------------------------------------------------

test('aceite dos Termos grava o IP visto pelo proxy confiável, não o forjado pelo cliente', { skip: needsDb }, async () => {
  // O cliente escreve "6.6.6.6"; o proxy (1 salto confiável) anexa o IP real.
  const r = await call('POST', '/api/consent', { user: COMUM, headers: { 'X-Forwarded-For': '6.6.6.6, 198.51.100.23' } });
  assert.equal(r.status, 200);
  const row = await db.prepare('SELECT ip FROM user_consents WHERE user_id=? ORDER BY accepted_at DESC LIMIT 1').get(COMUM);
  assert.equal(row.ip, '198.51.100.23');
});

// ---- 17) download por stream -------------------------------------------------------

test('arquivo que some antes da leitura responde 404 — o processo não cai', async () => {
  const r = await call('GET', `/arquivo?p=${encodeURIComponent(path.join(scratch, 'nao-existe.json'))}`);
  assert.equal(r.status, 404);
  const dir = await call('GET', `/arquivo?p=${encodeURIComponent(scratch)}`);
  assert.equal(dir.status, 404, 'diretório no lugar do arquivo também não derruba');
  // Arquivo real continua sendo entregue com o tipo certo.
  const file = path.join(scratch, 'doc.json');
  fs.writeFileSync(file, '{"ok":true}');
  const res = await fetch(`${baseUrl}/arquivo?p=${encodeURIComponent(file)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { ok: true });
});
