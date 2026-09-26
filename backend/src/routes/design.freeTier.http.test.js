// Modo Design x modo gratuito, pela ROTA: a recusa do modo gratuito (429 de
// limite, 403 de bloqueio) precisa chegar ao cliente com o status e o `code`
// certos. `generateArtifact` já devolvia status/code, mas `runGeneration`
// trocava tudo por um 502 fixo — a interface mostrava "falha do provedor" em
// vez da tela de limite com a hora de renovação.
//
// Rotas Express reais + PostgreSQL real + provedor OpenAI-compatível falso.
// Sem PostgreSQL, os testes de banco são pulados (mesma convenção dos demais).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let chamadas = 0;
const fakeProvider = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    chamadas += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: 'gratis:free',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '<!DOCTYPE html><html><body><h1>Oi</h1></body></html>' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    }));
  });
});
await new Promise(resolve => fakeProvider.listen(0, '127.0.0.1', resolve));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-design-route-free-'));
process.env.DATA_DIR = dataDir;
process.env.FREE_TIER_API_KEY = 'chave-da-plataforma-teste';
process.env.FREE_TIER_BASE_URL = `http://127.0.0.1:${fakeProvider.address().port}/v1`;
process.env.FREE_TIER_MODELS = 'gratis:free';
process.env.FREE_TIER_MSGS_PER_MIN = '100';

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const designRouter = (await import('./design.js')).default;

const USER = `design-route-free-${Date.now()}`;
let server, baseUrl;

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@t.local`, false, now(), now());
  await db.prepare('INSERT INTO user_settings (user_id, free_mode, created_at, updated_at) VALUES (?,?,?,?)').run(USER, 1, now(), now());
  await db.prepare('INSERT INTO free_tier_user_limits (user_id, msgs_per_day, updated_at) VALUES (?,?,?)').run(USER, 1, now());
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => { req.userId = USER; req.user = { id: USER }; next(); });
  app.use('/api', designRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  fakeProvider.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  for (const table of ['free_tier_events', 'free_tier_usage', 'free_tier_user_limits', 'free_tier_blocks', 'user_settings']) {
    try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(USER); } catch {}
  }
  try { await db.prepare('DELETE FROM "user" WHERE id=?').run(USER); } catch {}
});

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

let projectId = null;

test('primeira geração no modo gratuito passa e cria o projeto', { skip }, async () => {
  const r = await post('/design/projects', { outputType: 'web', prompt: 'uma página', model: 'free::gratis:free' });
  assert.equal(r.status, 200, r.text);
  projectId = r.json.id || r.json.project?.id;
  assert.ok(projectId);
  assert.equal(chamadas, 1);
});

test('limite gratuito estourado: a rota responde 429 com code, não 502', { skip }, async () => {
  const antes = chamadas;
  const r = await post(`/design/projects/${projectId}/generate`, { prompt: 'mude a cor' });
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json.code, 'free_limit');
  assert.ok(r.json.resetAt, 'a recusa traz quando o limite renova');
  assert.equal(chamadas, antes, 'o provedor não foi chamado');
});

test('bloqueio no modo gratuito chega como 403 também na criação de projeto', { skip }, async () => {
  await db.prepare('INSERT INTO free_tier_blocks (user_id, reason, created_at) VALUES (?,?,?)').run(USER, 'teste', now());
  try {
    const r = await post('/design/projects', { outputType: 'web', prompt: 'outra', model: 'free::gratis:free' });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'free_blocked');
    assert.ok(r.json.project?.id, 'o projeto fica de pé para o usuário tentar de novo');
  } finally {
    await db.prepare('DELETE FROM free_tier_blocks WHERE user_id=?').run(USER);
  }
});
