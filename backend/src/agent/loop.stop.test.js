// "Parar" no meio da resposta (Regra 4.2: cancelamento nunca vira "concluído").
//
// Medido com navegador real: ao clicar em Parar no meio de uma resposta em
// streaming, o texto parava em ~400 ms, mas a mensagem era gravada com
// execution_meta.state = "completed" — e a interface, que lê esse estado, não
// tinha como dizer que a resposta foi interrompida. Parecia uma resposta
// completa, antes e depois de recarregar.
//
// Roda o runAgent real contra PostgreSQL real e um provedor falso que manda
// uma palavra a cada 40 ms. Sem PostgreSQL, pulado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-loop-stop-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-loop-stop-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.PROVIDER_ALLOW_PRIVATE_URLS = 'true';

const PALAVRAS = Array.from({ length: 60 }, (_, i) => `P${i}`);
const fakeProvider = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', async () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let fechado = false;
    res.on('close', () => { fechado = true; });
    for (const p of PALAVRAS) {
      if (fechado) return;
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'lento', choices: [{ index: 0, delta: { content: `${p} ` }, finish_reason: null }] })}\n\n`);
      await new Promise(r => setTimeout(r, 40));
    }
    if (fechado) return;
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'lento', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
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
const { runMultiModel } = await import('./multiModel.js');
const { acquireConversationControl, releaseConversationControl, setControl } = await import('./control.js');
const { encryptSecret } = await import('../crypto.js');

const stamp = Date.now();
const USER = `loop-stop-${stamp}`;
const PROV = `lsprov${stamp}`;
const CONV = `loop-stop-conv-${stamp}`;

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@t.local`, false, now(), now());
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(PROV, USER, 'custom', 'Provedor lento', baseUrl, encryptSecret('sk-teste'),
      JSON.stringify([{ id: 'lento' }]), 'lento', now(), now());
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(CONV, USER, 'Parar', `${PROV}::lento`, now(), now());
}

test.after(async () => {
  fakeProvider.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  try { await db.prepare('DELETE FROM messages WHERE conversation_id=?').run(CONV); } catch {}
  try { await db.prepare('DELETE FROM conversations WHERE id=?').run(CONV); } catch {}
  try { await db.prepare('DELETE FROM user_ai_providers WHERE user_id=?').run(USER); } catch {}
  try { await db.prepare('DELETE FROM "user" WHERE id=?').run(USER); } catch {}
});

test('Parar no meio do streaming grava e emite o estado "stopped", nunca "completed"', { skip }, async () => {
  const control = acquireConversationControl(CONV, USER);
  const events = [];
  let deltas = 0;
  let result;
  try {
    result = await runAgent({
      userId: USER, conversationId: CONV, userText: 'Repita as palavras.', model: `${PROV}::lento`,
      control,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'delta' && /P\d/.test(e.content || '')) {
          deltas += 1;
          // Assíncrono de propósito, como o POST /control da vida real: o
          // Parar chega enquanto o loop ESPERA o próximo pedaço do provedor.
          // Disparado dentro do onEvent, ele cairia na checagem que já existia
          // no meio do processamento do pedaço e o bug não apareceria.
          if (deltas === 5) setTimeout(() => setControl(CONV, 'stop'), 5);
        }
      }
    });
  } finally {
    releaseConversationControl(CONV, control);
  }

  assert.ok(deltas >= 5, 'a resposta precisa ter começado antes do Parar');
  assert.ok(!/P59/.test(result.text || ''), 'o texto não pode ter ido até o fim depois do Parar');
  assert.equal(result.execution?.state, 'stopped', 'o resultado precisa dizer que foi interrompido');

  const estados = events.filter(e => e.type === 'run_state').map(e => e.execution?.state);
  assert.ok(estados.includes('stopped'), `o stream precisa emitir run_state "stopped" (emitiu: ${estados.join(', ')})`);
  assert.ok(!estados.includes('completed'), 'um run interrompido não pode ser anunciado como concluído');

  const salvo = await db.prepare("SELECT execution_meta FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(CONV);
  assert.equal(JSON.parse(salvo.execution_meta).state, 'stopped', 'o estado gravado precisa sobreviver a recarregar a conversa');
});

test('Pausar no meio do streaming continua a resposta depois, em vez de encerrá-la ali', { skip }, async () => {
  const conv = `${CONV}-pausa`;
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(conv, USER, 'Pausar', `${PROV}::lento`, now(), now());
  const control = acquireConversationControl(conv, USER);
  let deltas = 0;
  let result;
  try {
    result = await runAgent({
      userId: USER, conversationId: conv, userText: 'Repita as palavras.', model: `${PROV}::lento`,
      control,
      onEvent: (e) => {
        if (e.type === 'delta' && /P\d/.test(e.content || '')) {
          deltas += 1;
          if (deltas === 5) {
            setTimeout(() => setControl(conv, 'pause'), 5);
            setTimeout(() => setControl(conv, 'resume'), 400);
          }
        }
      }
    });
  } finally {
    releaseConversationControl(conv, control);
    await db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conv);
    await db.prepare('DELETE FROM conversations WHERE id=?').run(conv);
  }
  assert.equal(result.execution?.state, 'completed');
  assert.match(result.text || '', /P59/, 'depois de retomar, a resposta precisa ir até o fim — não parar onde foi pausada');
});

test('Multimodelo: Parar no meio marca os cartões como interrompidos, não como concluídos', { skip }, async () => {
  const conv = `${CONV}-multi`;
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(conv, USER, 'Multi', `${PROV}::lento`, now(), now());
  const control = acquireConversationControl(conv, USER);
  const events = [];
  let deltas = 0;
  try {
    await runMultiModel({
      userId: USER, conversationId: conv, userText: 'Repita as palavras.', control,
      config: { mode: 'compare', models: [{ id: `${PROV}::lento`, role: 'principal' }, { id: `${PROV}::lento`, role: 'revisor' }], coordinator: `${PROV}::lento`, context: 'none' },
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'mm_delta' && /P\d/.test(e.content || '')) {
          deltas += 1;
          if (deltas === 6) setTimeout(() => setControl(conv, 'stop'), 5);
        }
      }
    });
  } finally {
    releaseConversationControl(conv, control);
    await db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conv);
    await db.prepare('DELETE FROM conversations WHERE id=?').run(conv);
  }
  const finais = new Map();
  for (const e of events) if (e.type === 'mm_status') finais.set(e.slot, e.status);
  assert.ok(finais.size >= 1, 'os cartões precisam ter emitido estado');
  for (const [slot, status] of finais) {
    assert.notEqual(status, 'concluido', `o cartão ${slot} foi cortado pelo Parar e não pode aparecer como concluído`);
  }
});
