// Persona do Companion: o assistente escolhido em "Persona" precisa chegar ao
// prompt do chat do copiloto. Antes a tela prometia "dá voz e personalidade ao
// personagem" e o backend ignorava a escolha. E o escopo é do dono: apontar
// para o assistente de OUTRO usuário não pode vazar o perfil dele.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let ultimoCorpo = null;
const fakeProvider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    try { ultimoCorpo = JSON.parse(body); } catch { ultimoCorpo = null; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', model: 'modelo-proprio',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Oi.' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
    }));
  });
});
await new Promise(resolve => fakeProvider.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${fakeProvider.address().port}/v1`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-copilot-persona-'));
process.env.DATA_DIR = dataDir;
process.env.PROVIDER_ALLOW_PRIVATE_URLS = 'true';

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const { encryptSecret } = await import('../crypto.js');
const copilotRouter = (await import('./copilot.js')).default;

const stamp = Date.now();
const DONO = `persona-dono-${stamp}`;
const OUTRO = `persona-outro-${stamp}`;
const ASSIST_DONO = `asst-dono-${stamp}`;
const ASSIST_OUTRO = `asst-outro-${stamp}`;
let server, baseUrl;

async function gravarPersona(assistantId) {
  await db.prepare('DELETE FROM companion_settings WHERE user_id=?').run(DONO);
  await db.prepare('INSERT INTO companion_settings (user_id, settings, updated_at) VALUES (?,?,?)')
    .run(DONO, JSON.stringify({ enabled: true, assistantId }), now());
}

if (dbReady) {
  for (const id of [DONO, OUTRO]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@t.local`, false, now(), now());
  }
  await db.prepare(
    `INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(`prov-${DONO}`, DONO, 'openai', 'Falso', providerUrl, encryptSecret('sk-teste'),
    JSON.stringify([{ id: 'modelo-proprio' }]), 'modelo-proprio', now(), now());
  const inserirAssistente = 'INSERT INTO assistants (id,user_id,name,emoji,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)';
  await db.prepare(inserirAssistente).run(ASSIST_DONO, DONO, 'Contador', 'bot', 'modelo-proprio',
    'PERFIL-DO-DONO: especialista em contabilidade.', '[]', '{}', now(), now());
  await db.prepare(inserirAssistente).run(ASSIST_OUTRO, OUTRO, 'Segredo', 'bot', 'modelo-proprio',
    'PERFIL-DE-OUTRO-USUARIO', '[]', '{}', now(), now());

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => { req.userId = DONO; req.user = { id: DONO }; next(); });
  app.use('/api', copilotRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  fakeProvider.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  for (const table of ['companion_settings', 'copilot_messages', 'copilot_conversations', 'user_ai_providers', 'assistants']) {
    for (const id of [DONO, OUTRO]) {
      try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id); } catch {}
    }
  }
  for (const id of [DONO, OUTRO]) { try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {} }
});

async function conversar() {
  ultimoCorpo = null;
  const r = await fetch(`${baseUrl}/api/copilot/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Olá' })
  });
  assert.equal(r.status, 200, await r.text());
  return ultimoCorpo?.messages?.[0]?.content || '';
}

test('a persona escolhida no Companion entra no prompt do chat do copiloto', { skip }, async () => {
  await gravarPersona(ASSIST_DONO);
  const system = await conversar();
  assert.match(system, /PERFIL-DO-DONO/);
  assert.match(system, /<assistant-profile/);
});

test('sem persona, o prompt não carrega perfil de assistente', { skip }, async () => {
  await gravarPersona(null);
  const system = await conversar();
  assert.doesNotMatch(system, /<assistant-profile/);
});

test('persona apontando para assistente de OUTRO usuário é ignorada', { skip }, async () => {
  await gravarPersona(ASSIST_OUTRO);
  const system = await conversar();
  assert.doesNotMatch(system, /PERFIL-DE-OUTRO-USUARIO/);
  assert.doesNotMatch(system, /<assistant-profile/);
});
