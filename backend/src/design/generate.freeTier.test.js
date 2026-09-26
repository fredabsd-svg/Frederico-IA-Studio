// Modo Design x modo gratuito: a geração de design que cai na chave da
// PLATAFORMA passa pelos mesmos portões do chat — limite diário/por minuto,
// bloqueio, fila e contabilidade. Antes, generateArtifact chamava o provedor
// gratuito direto: gerar designs era um jeito de gastar a chave da casa sem
// teto e sem registro.
//
// Um servidor HTTP local faz o papel do provedor OpenAI-compatível, para
// contar quantas chamadas chegaram de fato.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let chamadas = 0;
const fakeProvider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-design-free-'));
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

const { generateArtifact } = await import('./generate.js');
const { freeTierDayKey } = await import('../freeTier.js');

const USER = `design-free-${Date.now()}`;

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@t.local`, false, now(), now());
  await db.prepare('INSERT INTO user_settings (user_id, free_mode, created_at, updated_at) VALUES (?,?,?,?)').run(USER, 1, now(), now());
  await db.prepare('INSERT INTO free_tier_user_limits (user_id, msgs_per_day, updated_at) VALUES (?,?,?)').run(USER, 1, now());
}

test.after(async () => {
  fakeProvider.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  for (const table of ['free_tier_events', 'free_tier_usage', 'free_tier_user_limits', 'user_settings']) {
    try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(USER); } catch {}
  }
  try { await db.prepare('DELETE FROM "user" WHERE id=?').run(USER); } catch {}
});

test('geração no modo gratuito CONTA no limite diário e fica registrada', { skip }, async () => {
  const r = await generateArtifact({ userId: USER, outputType: 'web', prompt: 'uma página', model: 'free::gratis:free' });
  assert.equal(r.ok, true, r.error);
  assert.equal(chamadas, 1);
  const uso = await db.prepare('SELECT msgs, tokens FROM free_tier_usage WHERE user_id=? AND day=?').get(USER, freeTierDayKey());
  assert.equal(Number(uso?.msgs), 1);
  assert.equal(Number(uso?.tokens), 30);
  const evento = await db.prepare("SELECT status, detail FROM free_tier_events WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(USER);
  assert.equal(evento.status, 'ok');
  assert.match(evento.detail, /design/);
});

test('limite gratuito estourado: a geração é recusada com 429 e o provedor NÃO é chamado', { skip }, async () => {
  const antes = chamadas;
  const r = await generateArtifact({ userId: USER, outputType: 'web', prompt: 'outra página', model: 'free::gratis:free' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.code, 'free_limit');
  assert.equal(chamadas, antes, 'nenhuma chamada à chave da plataforma');
});

test('usuário bloqueado no modo gratuito recebe 403 no Modo Design', { skip }, async () => {
  await db.prepare('INSERT INTO free_tier_blocks (user_id, reason, created_at) VALUES (?,?,?)').run(USER, 'teste', now());
  try {
    const r = await generateArtifact({ userId: USER, outputType: 'web', prompt: 'x', model: 'free::gratis:free' });
    assert.equal(r.status, 403);
    assert.equal(r.code, 'free_blocked');
  } finally {
    await db.prepare('DELETE FROM free_tier_blocks WHERE user_id=?').run(USER);
  }
});
