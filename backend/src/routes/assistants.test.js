// F-1 (causa-raiz do 401 do PR #140): a rota /api/assistants persiste a
// referência COMPLETA do modelo (`<provedor>::<modelo>`) em `model_ref`, e
// `model` continua guardando o id cru (legado) para a UI exibir o rótulo
// amigável. A inferência de `model_ref` é por catálogo: se o id nu estiver em
// UM dos provedores da conta, gravamos o `modelRef` completo; caso contrário,
// o `model_ref` fica NULL e o runtime trata em modo legado (erro claro).
//
// Segue a convenção do `design.http.test.js`: rotas Express reais + DB real +
// provedor falso. Sem DATABASE_URL, todos pulam.
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import test from 'node:test';
import { nanoid } from 'nanoid';

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js').then(m => m.runMigrations()); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const { encryptSecret } = await import('../crypto.js');
const assistantsRouter = (await import('./assistants.js')).default;

const stamp = Date.now();
const USER_A = `assist-http-a-${stamp}`;

let baseUrl;
let server;
let currentUser = USER_A;
const CATALOGO_DEEPSEEK = [{ id: 'deepseek-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }];
const CATALOGO_OPENROUTER = [
  { id: 'deepseek/deepseek-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }
];

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER_A, USER_A, `${USER_A}@teste.local`, false, now(), now());

  // Provedor mais antigo cadastrado primeiro para confundir o `rows[0]`
  // legado. O que importa aqui é que o modelRef gravado prevaleça.
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('prov-ds', USER_A, 'deepseek', 'DeepSeek', 'https://api.deepseek.com', encryptSecret('sk-ds'),
      JSON.stringify(CATALOGO_DEEPSEEK), 'deepseek-chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('prov-or', USER_A, 'openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', encryptSecret('sk-or'),
      JSON.stringify(CATALOGO_OPENROUTER), 'deepseek/deepseek-chat', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => { req.userId = currentUser; req.user = { id: currentUser }; next(); });
  app.use('/api', assistantsRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  if (!dbReady) return;
  await db.prepare('DELETE FROM assistants WHERE user_id=?').run(USER_A);
  await db.prepare('DELETE FROM user_ai_providers WHERE user_id=?').run(USER_A);
  await db.prepare('DELETE FROM "user" WHERE id=?').run(USER_A);
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// POST: gravar com id de modelo NU (formato nativo) deve resolver
// `model_ref` para o provedor DeepSeek. Antes da fix, o assistente ficaria só
// com `model='deepseek-chat'` e a próxima chamada cairia no rows[0].
test('POST /assistants resolve model_ref quando o id está em UM dos catálogos', { skip: needsDb }, async () => {
  const res = await call('POST', '/api/assistants', {
    name: 'Teste F-1',
    system_prompt: 'Você é o agente.',
    model: 'deepseek-chat'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.model, 'deepseek-chat');
  assert.equal(res.body.model_ref, 'prov-ds::deepseek-chat');
});

test('POST /assistants resolve model_ref com id no formato OpenRouter', { skip: needsDb }, async () => {
  const res = await call('POST', '/api/assistants', {
    name: 'Teste F-1 OpenRouter',
    system_prompt: 'Você é o agente.',
    model: 'deepseek/deepseek-chat'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.model, 'deepseek/deepseek-chat');
  assert.equal(res.body.model_ref, 'prov-or::deepseek/deepseek-chat');
});

test('POST /assistants aceita modelRef completo no formato <provedor>::<modelo>', { skip: needsDb }, async () => {
  const res = await call('POST', '/api/assistants', {
    name: 'Teste F-1 ref completa',
    system_prompt: 'Você é o agente.',
    model: 'prov-or::deepseek/deepseek-chat'
  });
  assert.equal(res.status, 200);
  // `model` fica o modelId cru (a UI exibe o rótulo), `model_ref` carrega o
  // prefixo do provedor (a chave da resolução inequívoca).
  assert.equal(res.body.model, 'deepseek/deepseek-chat');
  assert.equal(res.body.model_ref, 'prov-or::deepseek/deepseek-chat');
});

test('POST /assistants com id ausente em qualquer catálogo grava model_ref NULL', { skip: needsDb }, async () => {
  const res = await call('POST', '/api/assistants', {
    name: 'Teste F-1 sem catálogo',
    system_prompt: 'Você é o agente.',
    model: 'modelo-fora-de-catalogo'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.model, 'modelo-fora-de-catalogo');
  // model_ref fica NULL — o runtime vai devolver erro claro na próxima
  // chamada (em vez do chute silencioso do rows[0]).
  assert.equal(res.body.model_ref, null);
});

test('PUT /assistants/:id atualiza model_ref quando o modelo muda', { skip: needsDb }, async () => {
  const criado = await call('POST', '/api/assistants', {
    name: 'Teste F-1 PUT',
    system_prompt: 'Você é o agente.',
    model: 'deepseek-chat'
  });
  assert.equal(criado.body.model_ref, 'prov-ds::deepseek-chat');

  const atualizado = await call('PUT', `/api/assistants/${criado.body.id}`, {
    name: 'Teste F-1 PUT',
    system_prompt: 'Você é o agente.',
    model: 'deepseek/deepseek-chat'
  });
  assert.equal(atualizado.status, 200);
  assert.equal(atualizado.body.model, 'deepseek/deepseek-chat');
  assert.equal(atualizado.body.model_ref, 'prov-or::deepseek/deepseek-chat');
});

test('PUT /assistants/:id com model=null solta a fixação e volta ao default', { skip: needsDb }, async () => {
  const criado = await call('POST', '/api/assistants', {
    name: 'Teste F-1 soltar',
    system_prompt: 'Você é o agente.',
    model: 'deepseek-chat'
  });
  const solto = await call('PUT', `/api/assistants/${criado.body.id}`, {
    name: 'Teste F-1 soltar',
    system_prompt: 'Você é o agente.',
    model: ''
  });
  assert.equal(solto.status, 200);
  // Voltou ao default canônico (resolvido contra os catálogos do usuário).
  assert.equal(solto.body.model_ref, 'prov-or::deepseek/deepseek-chat');
});
