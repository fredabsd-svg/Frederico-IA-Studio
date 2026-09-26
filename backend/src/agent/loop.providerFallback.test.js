// Fallback de provedor e troca de modelo no runAgent (Regra 5.5: "fallback é
// explícito e rastreável").
//
//   1. `getUserProvider` agora devolve `fallback` quando o provedor pedido ficou
//      sem chave e quem atende é o modo gratuito. O runAgent precisa GRAVAR isso
//      no `execution_meta` da resposta e avisar o usuário UMA vez (a rota do
//      chat já pode ter avisado — sem duplicar).
//   2. `startedModel` era capturado DEPOIS de o modo gratuito trocar o modelo
//      pedido pelo gratuito padrão — o aviso de "modelo trocado" nunca saía.
//   3. MODEL_FALLBACKS com referência `free::` não pode entrar no failover de
//      um run que NÃO está no modo gratuito (sairia da contabilidade).
//
// Partes puras testadas direto; o fluxo 1–2 roda o runAgent real com
// PostgreSQL real e um provedor gratuito falso (SSE). Sem PostgreSQL, pulado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-loop-fallback-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-loop-fallback-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true';

let chamadas = 0;
const fakeProvider = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    chamadas += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'gratis:free', choices: [{ index: 0, delta: { role: 'assistant', content: 'Paris é a capital da França.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'gratis:free', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => fakeProvider.listen(0, '127.0.0.1', resolve));
process.env.FREE_TIER_API_KEY = 'chave-da-plataforma-teste';
process.env.FREE_TIER_BASE_URL = `http://127.0.0.1:${fakeProvider.address().port}/v1`;
process.env.FREE_TIER_MODELS = 'gratis:free';

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const { runAgent, buildFallbackChain, initialModelSwap } = await import('./loop.js');

// ---- Partes puras -----------------------------------------------------------

test('MODEL_FALLBACKS: run fora do modo gratuito ignora referências free::', () => {
  const chain = buildFallbackChain({
    provider: { source: 'user', modelRef: 'prov1::modelo-a' },
    chosenModel: 'prov1::modelo-a',
    envFallbacks: 'free::gratis:free, prov1::modelo-b ,free::outro,'
  });
  assert.deepEqual(chain, ['prov1::modelo-b']);
});

test('MODEL_FALLBACKS: no modo gratuito vale só a allowlist gratuita', () => {
  const chain = buildFallbackChain({
    provider: { source: 'free', modelRef: 'free::a', fallbackModels: ['free::b'] },
    chosenModel: 'free::a',
    envFallbacks: 'prov1::modelo-pago'
  });
  assert.deepEqual(chain, ['free::b']);
});

test('troca inicial de modelo é detectada quando o gratuito substitui o pedido', () => {
  const swap = initialModelSwap({
    provider: { source: 'free', fallback: { reason: 'provider_key_unavailable' } },
    requestedModel: 'prov1::modelo-pago',
    chosenModel: 'free::gratis:free'
  });
  assert.deepEqual(swap, { from: 'prov1::modelo-pago', to: 'free::gratis:free', reason: 'provider_key_unavailable' });
  assert.equal(initialModelSwap({ provider: { source: 'free' }, requestedModel: '', chosenModel: 'free::gratis:free' }), null);
  assert.equal(initialModelSwap({ provider: { source: 'free' }, requestedModel: 'free::gratis:free', chosenModel: 'free::gratis:free' }), null);
  assert.equal(initialModelSwap({ provider: { source: 'user' }, requestedModel: 'modelo-a', chosenModel: 'prov1::modelo-a' }), null);
  assert.equal(initialModelSwap({ provider: { source: 'free' }, requestedModel: 'free::pago', chosenModel: 'free::gratis:free' }).reason, 'free_allowlist');
});

// ---- Fluxo real -------------------------------------------------------------

const stamp = Date.now();
const USER = `loop-fallback-${stamp}`;
const PROV = `lfprov${stamp}`;
const CONVS = [];

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@t.local`, false, now(), now());
  await db.prepare('INSERT INTO user_settings (user_id, free_mode, created_at, updated_at) VALUES (?,?,?,?)').run(USER, 1, now(), now());
  // Chave ilegível (cifrada com outra chave mestra): o provedor existe, mas não serve.
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(PROV, USER, 'custom', 'Meu provedor', 'http://127.0.0.1:9/v1', 'aaa:bbb:ccc',
      JSON.stringify([{ id: 'modelo-pago' }]), 'modelo-pago', now(), now());
}

async function novaConversa() {
  const id = `loop-fallback-conv-${stamp}-${CONVS.length}`;
  CONVS.push(id);
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, USER, 'Fallback', `${PROV}::modelo-pago`, now(), now());
  return id;
}

test.after(async () => {
  fakeProvider.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  for (const id of CONVS) {
    try { await db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id); } catch {}
    try { await db.prepare('DELETE FROM conversations WHERE id=?').run(id); } catch {}
  }
  for (const table of ['user_ai_providers', 'user_settings', 'free_tier_events', 'free_tier_usage']) {
    try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(USER); } catch {}
  }
  try { await db.prepare('DELETE FROM "user" WHERE id=?').run(USER); } catch {}
});

test('fallback para o modo gratuito fica gravado no execution_meta, com aviso único e troca reportada', { skip }, async () => {
  const conversationId = await novaConversa();
  const events = [];
  const result = await runAgent({
    userId: USER, conversationId, userText: 'Qual é a capital da França?', model: `${PROV}::modelo-pago`,
    onEvent: e => events.push(e)
  });
  assert.ok(chamadas >= 1, 'a resposta veio do provedor gratuito');
  const avisos = events.filter(e => e.type === 'status' && /modo gratuito/.test(e.content || ''));
  assert.equal(avisos.length, 1, 'o usuário é avisado uma vez');
  const fb = result.execution?.providerFallback;
  assert.equal(fb?.to, 'free');
  assert.equal(fb?.reason, 'provider_key_unavailable');
  assert.equal(fb?.requestedProviderId, PROV);
  assert.match(fb?.message || '', /Meu provedor/);
  assert.deepEqual(result.execution?.modelSwap, { from: `${PROV}::modelo-pago`, to: 'free::gratis:free', reason: 'provider_key_unavailable' });
  // A troca aparece no TEXTO salvo (não só num status efêmero).
  assert.match(result.text, /modelo-pago/);
  assert.match(result.text, /gratis:free/);
  const saved = await db.prepare("SELECT execution_meta FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(conversationId);
  const meta = JSON.parse(saved.execution_meta);
  assert.equal(meta.providerFallback.reason, 'provider_key_unavailable');
  assert.equal(meta.modelSwap.to, 'free::gratis:free');
});

test('se a rota já avisou do fallback (controle marcado), o runAgent não repete o aviso', { skip }, async () => {
  const conversationId = await novaConversa();
  const { acquireConversationControl, releaseConversationControl } = await import('./control.js');
  const control = acquireConversationControl(conversationId, USER);
  control.providerFallbackNotified = true;
  const events = [];
  try {
    const result = await runAgent({
      userId: USER, conversationId, userText: 'Qual é a capital da França?', model: `${PROV}::modelo-pago`,
      onEvent: e => events.push(e), control
    });
    assert.equal(result.execution?.providerFallback?.reason, 'provider_key_unavailable');
  } finally {
    releaseConversationControl(conversationId, control);
  }
  const avisos = events.filter(e => e.type === 'status' && /modo gratuito/.test(e.content || ''));
  assert.equal(avisos.length, 0);
});
