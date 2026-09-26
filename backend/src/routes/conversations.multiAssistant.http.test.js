// Multimodelo x assistente escolhido, pela ROTA /chat.
//
// `runMultiModel` já sabia aplicar o perfil do assistente (system_prompt e
// personalidade) aos participantes e ao coordenador — coberto no nível do
// módulo por agent/teamAndMulti.prompts.test.js. Mas a rota nunca repassava o
// assistente: no multimodelo ela nem carregava o assistente escolhido no
// seletor, e o perfil simplesmente sumia. Este teste exercita o caminho
// inteiro (Express real + PostgreSQL real + provedor OpenAI-compatível falso,
// em streaming) e confere o que CHEGOU ao provedor.
//
// Sem PostgreSQL, os testes de banco são pulados (mesma convenção dos demais).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-multi-assist-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-multi-assist-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true';
delete process.env.RATE_MSGS_PER_DAY;

// Provedor falso: guarda cada requisição e responde em SSE (stream: true) ou
// JSON, conforme o pedido.
const requests = [];
const fakeProvider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    requests.push(parsed);
    const text = 'Parecer do modelo.';
    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: parsed.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
      res.write(chunk({ role: 'assistant', content: text }));
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: parsed.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
  });
});
await new Promise(resolve => fakeProvider.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${fakeProvider.address().port}/v1`;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const conversationsRouter = (await import('./conversations.js')).default;
const { encryptSecret } = await import('../crypto.js');

const stamp = Date.now();
const USER = `multi-assist-${stamp}`;
const PROV = `maprov${stamp}`;
const CONV = `multi-assist-conv-${stamp}`;
const ASSISTENTE = `multi-assist-a-${stamp}`;
const PERFIL = `PERFIL-DO-ASSISTENTE-${stamp}: responda sempre como auditor fiscal.`;

let server, baseUrl;

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@teste.local`, false, now(), now());
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(PROV, USER, 'custom', 'Provedor falso', providerUrl, encryptSecret('sk-teste'),
      JSON.stringify([{ id: 'modelo-a' }, { id: 'modelo-b' }]), 'modelo-a', now(), now());
  await db.prepare(`INSERT INTO assistants (id,user_id,name,emoji,model,model_ref,system_prompt,tools,personality,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ASSISTENTE, USER, 'Auditor', 'bot', 'modelo-a', `${PROV}::modelo-a`, PERFIL, '[]', '{}', now(), now());
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(CONV, USER, 'Conversa multimodelo', `${PROV}::modelo-a`, now(), now());

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = USER; req.user = { id: USER, email: `${USER}@teste.local` }; next(); });
  app.use('/api', conversationsRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: 'Erro interno do servidor.' }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  fakeProvider.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  for (const sql of [
    'DELETE FROM pipeline_runs WHERE conversation_id=?',
    'DELETE FROM files WHERE conversation_id=?',
    'DELETE FROM messages WHERE conversation_id=?',
    'DELETE FROM conversations WHERE id=?'
  ]) { try { await db.prepare(sql).run(CONV); } catch {} }
  for (const table of ['assistants', 'user_ai_providers', 'usage']) {
    try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(USER); } catch {}
  }
  try { await db.prepare('DELETE FROM "user" WHERE id=?').run(USER); } catch {}
});

test('multimodelo pela rota: o perfil do assistente escolhido chega aos participantes', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${CONV}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Compare os regimes de tributação para uma clínica médica.',
      assistantId: ASSISTENTE,
      multiModel: { mode: 'compare', models: [{ id: `${PROV}::modelo-a` }, { id: `${PROV}::modelo-b` }] }
    })
  });
  assert.equal(res.status, 200);
  const stream = await res.text(); // consome o SSE até o fim do run
  assert.match(stream, /"type":"done"/);
  const participantes = requests.filter(r => ['modelo-a', 'modelo-b'].includes(r.model));
  assert.ok(participantes.length >= 2, `os dois modelos foram chamados (chamadas: ${requests.length})`);
  for (const r of participantes) {
    const sistema = (r.messages || []).filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    assert.ok(sistema.includes(PERFIL), `o perfil do assistente está no prompt de ${r.model}`);
  }
});
