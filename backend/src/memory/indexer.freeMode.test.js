// Memória x modo gratuito x importação concorrente (auditoria 2026-09).
//
//   1. A extração de fatos (pós-resposta e na importação) resolvia o provedor
//      com `getUserProvider(userId)` — que devolve a chave da PLATAFORMA no
//      modo gratuito. Essas chamadas de segundo plano não passam por limite,
//      fila nem contabilidade: gastavam a chave da casa em silêncio. Agora, no
//      modo gratuito, a extração é PULADA de forma explícita (registrada e
//      informada no status da importação); os trechos locais seguem salvos.
//   2. O estado da importação era UM objeto global com UMA trava: a importação
//      de um usuário bloqueava a de todos os outros. Agora é por usuário.
//
// PostgreSQL real + provedor gratuito falso que conta chamadas. Sem
// PostgreSQL, os testes de banco são pulados.
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
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'gratis:free', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"facts":[]}' } }], usage: { total_tokens: 3 } }));
  });
});
await new Promise(resolve => fakeProvider.listen(0, '127.0.0.1', resolve));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-indexer-free-'));
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.FREE_TIER_API_KEY = 'chave-da-plataforma-teste';
process.env.FREE_TIER_BASE_URL = `http://127.0.0.1:${fakeProvider.address().port}/v1`;
process.env.FREE_TIER_MODELS = 'gratis:free';

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const { importConversations, extractionProviderFor, startImport, getImportStatus } = await import('./indexer.js');

const stamp = Date.now();
const GRATIS = `idx-free-${stamp}`;
const OUTRO = `idx-outro-${stamp}`;

if (dbReady) {
  for (const id of [GRATIS, OUTRO]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@t.local`, false, now(), now());
  }
  await db.prepare('INSERT INTO user_settings (user_id, free_mode, created_at, updated_at) VALUES (?,?,?,?)').run(GRATIS, 1, now(), now());
}

test.after(async () => {
  fakeProvider.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  for (const id of [GRATIS, OUTRO]) {
    for (const table of ['conversation_chunks', 'memory', 'memory_suggestions', 'user_settings']) {
      try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id); } catch {}
    }
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});

async function esperarImportacao(userId) {
  for (let i = 0; i < 100; i++) {
    const s = getImportStatus(userId);
    if (s.done) return s;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('a importação não terminou');
}

test('extração pós-resposta NÃO usa a chave da plataforma no modo gratuito', { skip }, async () => {
  assert.equal(await extractionProviderFor(GRATIS, 'free::gratis:free'), null);
  assert.equal(await extractionProviderFor(GRATIS), null);
});

test('importação no modo gratuito salva os trechos e pula a extração de fatos, de forma explícita', { skip }, async () => {
  const antes = chamadas;
  const r = await importConversations(GRATIS, 'antigas.txt', Buffer.from('Usuário: prefiro relatórios em PDF.\nAssistente: anotado.'));
  assert.equal(chamadas, antes, 'nenhuma chamada à chave da plataforma');
  assert.ok(r.chunks >= 1, 'os trechos (locais, sem custo) continuam sendo salvos');
  assert.equal(r.facts, 0);
  assert.equal(r.factsSkipped, 'free_mode');
});

test('importação é por usuário: uma não bloqueia a de outra conta, e o progresso é só do dono', { skip }, async () => {
  const a = startImport(GRATIS, 'a.txt', Buffer.from('Usuário: oi.\nAssistente: olá.'));
  const b = startImport(OUTRO, 'b.txt', Buffer.from('Usuário: tudo bem?\nAssistente: sim.'));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'a importação de outro usuário não fica bloqueada');
  // Mesma conta, duas ao mesmo tempo: recusa (a primeira ainda está rodando).
  // (o estado `running` é marcado de forma síncrona em startImport).
  const repetida = startImport(GRATIS, 'c.txt', Buffer.from('x'));
  assert.equal(repetida.ok, false);
  assert.match(repetida.error, /andamento/);
  const sa = await esperarImportacao(GRATIS);
  const sb = await esperarImportacao(OUTRO);
  assert.equal(sa.file, 'a.txt');
  assert.equal(sb.file, 'b.txt');
  assert.equal(sa.factsSkipped, 'free_mode');
  // Quem nunca importou vê o estado ocioso — nunca o arquivo de outra conta.
  const ninguem = getImportStatus(`idx-ninguem-${stamp}`);
  assert.equal(ninguem.file, '');
  assert.equal(ninguem.running, false);
});
