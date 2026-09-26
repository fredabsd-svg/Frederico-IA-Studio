// Troca por modelo de reserva NO MEIO da execução fica gravada no
// execution_meta (`modelFailover`), não só na nota em itálico do texto.
//
// É o que alimenta o selo "Modelo de reserva" da mensagem: ao vivo (run_state)
// e ao reabrir a conversa. Antes, o registro estruturado só existia para a troca
// ANTES do primeiro passo (`modelSwap`, modo gratuito); a troca por falha do
// provedor ficava só no texto, e a interface não tinha como mostrá-la.
//
// Roda o runAgent real contra PostgreSQL real e um provedor falso que devolve
// 503 para o modelo escolhido e responde normalmente com o modelo de reserva.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-failover-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-failover-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.PROVIDER_ALLOW_PRIVATE_URLS = 'true';

const fakeProvider = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    let model = '';
    try { model = JSON.parse(corpo).model; } catch {}
    if (model === 'caiu') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'serviço indisponível' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'RESPOSTA DA RESERVA' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => fakeProvider.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${fakeProvider.address().port}/v1`;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const { runAgent } = await import('./loop.js');
const { encryptSecret } = await import('../crypto.js');

const stamp = Date.now();
const USER = `failover-${stamp}`;
const PROV = `foprov${stamp}`;
const CONV = `failover-conv-${stamp}`;

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@t.local`, false, now(), now());
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(PROV, USER, 'custom', 'Provedor instável', baseUrl, encryptSecret('sk-teste'),
      JSON.stringify([{ id: 'caiu' }, { id: 'reserva' }]), 'reserva', now(), now());
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(CONV, USER, 'Reserva', `${PROV}::caiu`, now(), now());
}

test.after(async () => {
  delete process.env.MODEL_FALLBACKS;
  fakeProvider.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  try { await db.prepare('DELETE FROM messages WHERE conversation_id=?').run(CONV); } catch {}
  try { await db.prepare('DELETE FROM conversations WHERE id=?').run(CONV); } catch {}
  try { await db.prepare('DELETE FROM user_ai_providers WHERE user_id=?').run(USER); } catch {}
  try { await db.prepare('DELETE FROM "user" WHERE id=?').run(USER); } catch {}
});

test('modelo de reserva acionado no meio do run fica no execution_meta como modelFailover', { skip }, async () => {
  // Cadeia de reserva declarada como na vida real (lida a cada run).
  process.env.MODEL_FALLBACKS = `${PROV}::reserva`;
  const eventos = [];
  const result = await runAgent({
    userId: USER, conversationId: CONV, userText: 'Diga oi.', model: `${PROV}::caiu`,
    onEvent: (e) => eventos.push(e)
  });

  assert.match(result.text || '', /RESPOSTA DA RESERVA/);
  assert.deepEqual(result.execution?.modelFailover, { from: `${PROV}::caiu`, to: `${PROV}::reserva` });

  const final = eventos.filter(e => e.type === 'run_state').at(-1);
  assert.deepEqual(final.execution?.modelFailover, result.execution.modelFailover,
    'o run_state final precisa trazer a troca para o selo ao vivo');

  const salvo = await db.prepare("SELECT execution_meta FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(CONV);
  assert.deepEqual(JSON.parse(salvo.execution_meta).modelFailover, result.execution.modelFailover,
    'o registro precisa sobreviver a reabrir a conversa');
});
