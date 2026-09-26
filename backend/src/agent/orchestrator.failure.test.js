// Modo Equipe (runOrchestrator): falha do coordenador NUNCA vira "concluído".
//
// Antes: um erro do provedor no coordenador virava texto comum ("Não foi
// possível responder: …") sem `providerFailure`; uma resposta vazia virava
// "Concluído."; e a conta sem chave devolvia a orientação sem marca de falha.
// Nos três casos `classifyTaskResult` dizia `done` — a rota não emitia
// `execution_failed` e a interface mostrava sucesso (Regra 4.2).
//
// runOrchestrator real + PostgreSQL real + provedor OpenAI-compatível falso
// cujo comportamento cada teste escolhe. Sem PostgreSQL, é pulado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-orq-fail-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-orq-fail-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true';
delete process.env.FREE_TIER_API_KEY;

// 'erro'  → HTTP 400 (não retentável);
// 'vazio' → stream válido sem nenhum texto;
// 'ok'    → stream com uma resposta normal.
let modo = 'ok';
const fakeProvider = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    if (modo === 'erro') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Requisição recusada pelo modelo.' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const content = modo === 'vazio' ? '' : 'Regime de caixa reconhece receitas quando recebidas.';
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'modelo-coord', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'modelo-coord', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => fakeProvider.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${fakeProvider.address().port}/v1`;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const { runOrchestrator } = await import('./orchestrator.js');
const { classifyTaskResult } = await import('../taskOutcome.js');
const { encryptSecret } = await import('../crypto.js');

const stamp = Date.now();
const USER = `orq-fail-${stamp}`;
const SEM_CHAVE = `orq-semchave-${stamp}`;
const PROV = `orqprov${stamp}`;
const CONVS = [];

if (dbReady) {
  for (const id of [USER, SEM_CHAVE]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@t.local`, false, now(), now());
  }
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(PROV, USER, 'custom', 'Provedor falso', providerUrl, encryptSecret('sk-teste'),
      JSON.stringify([{ id: 'modelo-coord' }]), 'modelo-coord', now(), now());
}

async function novaConversa(userId) {
  const id = `orq-fail-conv-${stamp}-${CONVS.length}`;
  CONVS.push(id);
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, 'Equipe', `${PROV}::modelo-coord`, now(), now());
  return id;
}

async function rodar(userId) {
  const conversationId = await novaConversa(userId);
  const events = [];
  const result = await runOrchestrator({
    userId, conversationId, userText: 'Explique em uma frase o que é regime de caixa.',
    model: `${PROV}::modelo-coord`, assistants: [], onEvent: e => events.push(e)
  });
  const saved = await db.prepare("SELECT content, execution_meta FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(conversationId);
  return { result, events, saved };
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
  for (const id of [USER, SEM_CHAVE]) {
    try { await db.prepare('DELETE FROM user_ai_providers WHERE user_id=?').run(id); } catch {}
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});

test('erro do provedor no coordenador é falha do provedor, não "concluído"', { skip }, async () => {
  modo = 'erro';
  const { result, events, saved } = await rodar(USER);
  assert.equal(result.providerFailure, true);
  assert.ok(result.failureMessage);
  assert.equal(classifyTaskResult(result).status, 'error');
  const estado = events.filter(e => e.type === 'run_state').at(-1)?.execution?.state;
  assert.equal(estado, 'recoverable_error');
  assert.equal(JSON.parse(saved.execution_meta).state, 'recoverable_error');
});

test('coordenador sem texto não vira "Concluído."', { skip }, async () => {
  modo = 'vazio';
  const { result, saved } = await rodar(USER);
  assert.notEqual(result.text.trim(), 'Concluído.');
  assert.equal(result.incomplete, true);
  assert.equal(classifyTaskResult(result).status, 'error');
  assert.notEqual(saved.content.trim(), 'Concluído.');
  assert.equal(JSON.parse(saved.execution_meta).state, 'fatal_error');
});

test('resposta normal do coordenador continua concluída', { skip }, async () => {
  modo = 'ok';
  const { result } = await rodar(USER);
  assert.match(result.text, /Regime de caixa/);
  assert.equal(classifyTaskResult(result).status, 'done');
});

test('Modo Equipe sem chave é falha de configuração explícita', { skip }, async () => {
  const { result, saved } = await rodar(SEM_CHAVE);
  assert.equal(result.configurationError, true);
  assert.equal(classifyTaskResult(result).status, 'error');
  assert.equal(JSON.parse(saved.execution_meta).state, 'fatal_error');
});
