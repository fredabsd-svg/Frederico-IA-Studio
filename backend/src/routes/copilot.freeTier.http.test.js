// Copiloto x modo gratuito: as chamadas do copiloto ao provedor (chat, resumo,
// revisão, ações executivas) que caem na chave da PLATAFORMA passam pelos
// mesmos portões do /chat — limite diário/por minuto, bloqueio, fila e
// contabilidade. Antes, `resolveProvider` devolvia o provedor gratuito e a rota
// chamava direto: o copiloto era um jeito de gastar a chave da casa sem teto e
// sem registro.
//
// Rotas Express reais + PostgreSQL real + um provedor OpenAI-compatível FALSO
// (servidor HTTP local) que conta quantas chamadas chegaram de fato.
// Sem PostgreSQL, os testes de banco são pulados (mesma convenção dos demais).
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
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Resposta do copiloto.' } }],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 }
    }));
  });
});
await new Promise(resolve => fakeProvider.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${fakeProvider.address().port}/v1`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-copilot-free-'));
process.env.DATA_DIR = dataDir;
process.env.FREE_TIER_API_KEY = 'chave-da-plataforma-teste';
process.env.FREE_TIER_BASE_URL = providerUrl;
process.env.FREE_TIER_MODELS = 'gratis:free';
process.env.FREE_TIER_MSGS_PER_MIN = '100';

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const { encryptSecret } = await import('../crypto.js');
const copilotRouter = (await import('./copilot.js')).default;
const { freeTierDayKey } = await import('../freeTier.js');

const stamp = Date.now();
const GRATIS = `copilot-free-${stamp}`;       // só modo gratuito, limite de 1/dia
const BYOK = `copilot-byok-${stamp}`;         // chave própria (não conta no gratuito)
let currentUser = GRATIS;
let server, baseUrl;

if (dbReady) {
  for (const id of [GRATIS, BYOK]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@t.local`, false, now(), now());
    await db.prepare('INSERT INTO user_settings (user_id, free_mode, created_at, updated_at) VALUES (?,?,?,?)').run(id, 1, now(), now());
  }
  await db.prepare('INSERT INTO free_tier_user_limits (user_id, msgs_per_day, updated_at) VALUES (?,?,?)').run(GRATIS, 1, now());
  await db.prepare(
    `INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(`prov-${BYOK}`, BYOK, 'openai', 'Falso', providerUrl, encryptSecret('sk-teste'),
    JSON.stringify([{ id: 'modelo-proprio' }]), 'modelo-proprio', now(), now());

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => { req.userId = currentUser; req.user = { id: currentUser }; next(); });
  app.use('/api', copilotRouter);
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
  for (const id of [GRATIS, BYOK]) {
    for (const table of ['free_tier_events', 'free_tier_usage', 'free_tier_user_limits', 'free_tier_blocks', 'user_settings']) {
      try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id); } catch {}
    }
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});

async function post(pathname, body, user = GRATIS) {
  currentUser = user;
  const res = await fetch(`${baseUrl}/api${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function usoHoje(user) {
  const row = await db.prepare('SELECT msgs, tokens FROM free_tier_usage WHERE user_id=? AND day=?').get(user, freeTierDayKey());
  return { msgs: Number(row?.msgs || 0), tokens: Number(row?.tokens || 0) };
}

test('chat do copiloto no modo gratuito CONTA no limite diário e fica registrado', { skip }, async () => {
  const antes = chamadas;
  const r = await post('/copilot/chat', { text: 'Oi, copiloto' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.message.content, 'Resposta do copiloto.');
  assert.equal(chamadas, antes + 1);
  assert.deepEqual(await usoHoje(GRATIS), { msgs: 1, tokens: 12 });
  const evento = await db.prepare('SELECT status, detail FROM free_tier_events WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(GRATIS);
  assert.equal(evento.status, 'ok');
  assert.match(evento.detail, /copiloto:chat/);
});

test('limite gratuito estourado: revisão e ações do copiloto recebem 429 e o provedor NÃO é chamado', { skip }, async () => {
  const antes = chamadas;
  const revisao = await post('/copilot/revise', { text: 'texto com erro' });
  assert.equal(revisao.status, 429, revisao.text);
  assert.equal(revisao.json.code, 'free_limit');
  assert.ok(revisao.json.resetAt, 'a recusa traz quando o limite renova');
  const acao = await post('/copilot/tools/executive-action', { action: 'logic-review', content: 'se A então B' });
  assert.equal(acao.status, 429);
  assert.equal(acao.json.code, 'free_limit');
  const chat = await post('/copilot/chat', { text: 'de novo' });
  assert.equal(chat.status, 429);
  assert.equal(chamadas, antes, 'nenhuma chamada à chave da plataforma');
  assert.deepEqual(await usoHoje(GRATIS), { msgs: 1, tokens: 12 }, 'recusa não consome cota');
});

test('usuário bloqueado no modo gratuito recebe 403 no resumo do copiloto', { skip }, async () => {
  await db.prepare('INSERT INTO free_tier_blocks (user_id, reason, created_at) VALUES (?,?,?)').run(GRATIS, 'teste', now());
  try {
    const antes = chamadas;
    // O chat do teste 1 deixou duas mensagens: o resumo chega até o provedor.
    const r = await post('/copilot/actions/summary', {});
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'free_blocked');
    assert.equal(chamadas, antes);
  } finally {
    await db.prepare('DELETE FROM free_tier_blocks WHERE user_id=?').run(GRATIS);
  }
});

test('com chave própria o copiloto NÃO passa pelo modo gratuito (nem conta, nem registra)', { skip }, async () => {
  const r = await post('/copilot/revise', { text: 'texto com erro' }, BYOK);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.revised, 'Resposta do copiloto.');
  assert.deepEqual(await usoHoje(BYOK), { msgs: 0, tokens: 0 });
  const eventos = await db.prepare('SELECT COUNT(*) AS n FROM free_tier_events WHERE user_id=?').get(BYOK);
  assert.equal(Number(eventos.n), 0);
});
