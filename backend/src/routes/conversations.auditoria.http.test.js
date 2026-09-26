// Rotas de conversa exercitadas por HTTP de verdade (Express real +
// autenticação simulada + PostgreSQL real), cobrindo os defeitos da auditoria
// 2026-09 que moram em routes/conversations.js e routes/tasks.js:
//
//   2) MODO GRATUITO BURLÁVEL: o /chat decidia "é modo gratuito?" pelo provedor
//      PADRÃO da conta, sem olhar o modelo pedido. Quem tinha chave própria e
//      escolhia "free::X" usava a chave da plataforma sem limite, fila nem
//      contabilidade. A retomada de pipeline (/resume) nem passava pelos
//      portões do modo gratuito nem pelo teto de execuções simultâneas.
//   4) QUARENTENA: o INSERT em quarantined_uploads saía sem await, e um
//      caminho uploads/.quarantine/ era aceito como anexo — arquivo não
//      verificado chegando à IA.
//  11) /truncate com resposta em andamento; 409 antes de provar a posse
//      (revelava a conversa de outro usuário) no /chat e no POST /tasks.
//  12) worker de tarefas sobrescrevia um cancelamento (UPDATE sem status).
//  16) /resume de pipeline respondia status HTTP depois do flushHeaders.
//  18) o modelo escolhido no chat não era gravado na conversa.
//   7) GET /stream de um run já terminado ficava pendurado para sempre; com
//      runId antigo, o replay era descartado.
//
// Sem PostgreSQL, os testes de banco são pulados (mesma convenção dos demais).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-conv-free-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-conv-free-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true';
// Modo gratuito configurado, apontando para uma porta fechada: se algum teste
// deixar a chamada passar, ela falha na hora em vez de sair para a internet.
process.env.FREE_TIER_API_KEY = 'chave-da-plataforma-teste';
process.env.FREE_TIER_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.FREE_TIER_MODELS = 'modelo-gratis:free';
delete process.env.CLAMAV_HOST;
delete process.env.CLAMAV_REQUIRED;
delete process.env.RATE_MSGS_PER_DAY;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const conversationsRouter = (await import('./conversations.js')).default;
const tasksModule = await import('./tasks.js');
const { encryptSecret } = await import('../crypto.js');
const { freeTierDayKey } = await import('../freeTier.js');
const { createPipelineRun } = await import('../agent/pipelineRuns.js');
const { acquireConversationControl, releaseConversationControl } = await import('../agent/control.js');
const { openLiveStream } = await import('../liveStream.js');

const stamp = Date.now();
const PAGANTE = `cf-pagante-${stamp}`;   // tem chave própria E aderiu ao modo gratuito
const INTRUSO = `cf-intruso-${stamp}`;
const SEM_CHAVE = `cf-semchave-${stamp}`; // sem provedor e sem modo gratuito
const PROV = `cfprov${stamp}`;
const CONV = {
  chat: `cf-chat-${stamp}`,
  multi: `cf-multi-${stamp}`,
  assist: `cf-assist-${stamp}`,
  pipe: `cf-pipe-${stamp}`,
  pipeRuns: `cf-piperuns-${stamp}`,
  outra: `cf-outra-${stamp}`,
  ativa: `cf-ativa-${stamp}`,
  modelo: `cf-modelo-${stamp}`,
  stream: `cf-stream-${stamp}`,
  quarentena: `cf-quar-${stamp}`
};
const ASSISTENTE = `cf-assistente-${stamp}`;

let server, baseUrl;
let currentUser = PAGANTE;

async function insertConversation(id, userId) {
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, 'Conversa de teste', 'modelo-inicial', now(), now());
}

if (dbReady) {
  for (const id of [PAGANTE, INTRUSO, SEM_CHAVE]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@teste.local`, false, now(), now());
  }
  await db.prepare(`INSERT INTO user_ai_providers (id,user_id,provider_type,name,base_url,api_key_enc,models,default_model,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(PROV, PAGANTE, 'custom', 'Provedor próprio', 'http://127.0.0.1:9/v1', encryptSecret('sk-do-proprio-usuario'),
      JSON.stringify([{ id: 'modelo-proprio' }]), 'modelo-proprio', now(), now());
  await db.prepare('INSERT INTO user_settings (user_id, free_mode, created_at, updated_at) VALUES (?,?,?,?)').run(PAGANTE, 1, now(), now());
  // Limite gratuito individual de 1 mensagem/dia, já estourado hoje (no fuso do app).
  await db.prepare('INSERT INTO free_tier_user_limits (user_id, msgs_per_day, updated_at) VALUES (?,?,?)').run(PAGANTE, 1, now());
  await db.prepare('INSERT INTO free_tier_usage (user_id, day, msgs, tokens) VALUES (?,?,?,?)').run(PAGANTE, freeTierDayKey(), 5, 0);
  await db.prepare(`INSERT INTO assistants (id,user_id,name,emoji,model,model_ref,system_prompt,tools,personality,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ASSISTENTE, PAGANTE, 'Assistente grátis', 'bot', 'modelo-gratis:free', 'free::modelo-gratis:free', '', '[]', '{}', now(), now());
  for (const key of ['chat', 'multi', 'assist', 'pipe', 'pipeRuns', 'outra', 'ativa', 'stream']) await insertConversation(CONV[key], PAGANTE);
  await insertConversation(CONV.modelo, SEM_CHAVE);
  await insertConversation(CONV.quarentena, SEM_CHAVE);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = currentUser; req.user = { id: currentUser, email: `${currentUser}@teste.local` }; next(); });
  app.use('/api', conversationsRouter);
  app.use('/api', tasksModule.default);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: 'Erro interno do servidor.' }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  const convIds = Object.values(CONV);
  const ph = convIds.map(() => '?').join(',');
  for (const sql of [
    `DELETE FROM pipeline_runs WHERE conversation_id IN (${ph})`,
    `DELETE FROM quarantined_uploads WHERE conversation_id IN (${ph})`,
    `DELETE FROM files WHERE conversation_id IN (${ph})`,
    `DELETE FROM messages WHERE conversation_id IN (${ph})`,
    `DELETE FROM tasks WHERE conversation_id IN (${ph})`,
    `DELETE FROM conversations WHERE id IN (${ph})`
  ]) { try { await db.prepare(sql).run(...convIds); } catch {} }
  for (const id of [PAGANTE, INTRUSO, SEM_CHAVE]) {
    for (const table of ['free_tier_events', 'free_tier_usage', 'free_tier_user_limits', 'user_settings', 'user_ai_providers', 'assistants', 'usage', 'tasks']) {
      try { await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id); } catch {}
    }
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});

async function post(route, body, user = currentUser) {
  currentUser = user;
  const res = await fetch(`${baseUrl}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, type, text, body: json };
}

// ---- 2) Modo gratuito decidido pelo MODELO pedido --------------------------

test('BURLA FECHADA: chave própria + modelo "free::" passa pelo limite do modo gratuito (429)', { skip: needsDb }, async () => {
  const r = await post(`/conversations/${CONV.chat}/chat`, { message: 'oi', model: 'free::modelo-gratis:free' }, PAGANTE);
  assert.equal(r.status, 429, `esperava a recusa do limite gratuito, veio ${r.status}: ${r.text.slice(0, 200)}`);
  assert.equal(r.body.code, 'free_limit');
  const evento = await db.prepare("SELECT status, detail FROM free_tier_events WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(PAGANTE);
  assert.equal(evento?.status, 'limited', 'a recusa fica registrada na auditoria do modo gratuito');
  const msgs = await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(CONV.chat);
  assert.equal(Number(msgs.n), 0, 'nenhuma mensagem foi processada');
});

test('BURLA FECHADA: multimodelo com UM membro "free::" também respeita o limite gratuito', { skip: needsDb }, async () => {
  const r = await post(`/conversations/${CONV.multi}/chat`, {
    message: 'compare',
    multiModel: { mode: 'compare', models: [{ id: `${PROV}::modelo-proprio` }, { id: 'free::modelo-gratis:free' }] }
  }, PAGANTE);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'free_limit');
});

test('BURLA FECHADA: assistente fixado em modelo gratuito conta como modo gratuito', { skip: needsDb }, async () => {
  const r = await post(`/conversations/${CONV.assist}/chat`, { message: 'oi', assistantId: ASSISTENTE }, PAGANTE);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'free_limit');
});

test('retomada de pipeline com membro gratuito: limite aplicado ANTES do SSE (429 JSON, não 200)', { skip: needsDb }, async () => {
  await createPipelineRun({
    conversationId: CONV.pipe,
    userId: PAGANTE,
    mode: 'pipeline',
    totalStages: 2,
    config: { mode: 'pipeline', models: [{ id: `${PROV}::modelo-proprio` }, { id: 'free::modelo-gratis:free' }], coordinator: `${PROV}::modelo-proprio` },
    state: { execution: { objective: 'tarefa longa' } }
  });
  const r = await post(`/conversations/${CONV.pipe}/resume`, {}, PAGANTE);
  assert.equal(r.status, 429, `a recusa precisa vir no status HTTP; veio ${r.status} (${r.type})`);
  assert.match(r.type, /application\/json/, 'a recusa não pode chegar como stream de "sucesso"');
  assert.equal(r.body.code, 'free_limit');
});

test('retomada de pipeline respeita o teto de execuções simultâneas por usuário', { skip: needsDb }, async () => {
  await createPipelineRun({
    conversationId: CONV.pipeRuns,
    userId: PAGANTE,
    mode: 'pipeline',
    totalStages: 2,
    config: { mode: 'pipeline', models: [{ id: `${PROV}::modelo-proprio` }, { id: `${PROV}::modelo-proprio` }], coordinator: `${PROV}::modelo-proprio` },
    state: { execution: { objective: 'tarefa longa' } }
  });
  const prev = process.env.MAX_ACTIVE_RUNS_PER_USER;
  process.env.MAX_ACTIVE_RUNS_PER_USER = '1';
  const outra = acquireConversationControl(CONV.outra, PAGANTE); // 1 execução já ativa
  try {
    const r = await post(`/conversations/${CONV.pipeRuns}/resume`, {}, PAGANTE);
    assert.equal(r.status, 429);
    assert.match(r.body.error, /processando ao mesmo tempo/);
  } finally {
    releaseConversationControl(CONV.outra, outra);
    if (prev === undefined) delete process.env.MAX_ACTIVE_RUNS_PER_USER; else process.env.MAX_ACTIVE_RUNS_PER_USER = prev;
  }
});

// ---- 11) Estado x posse ----------------------------------------------------

test('/truncate com resposta em andamento é 409 e não apaga nada', { skip: needsDb }, async () => {
  await db.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)')
    .run(`cf-msg-${stamp}`, CONV.ativa, 'user', 'mensagem original', now());
  const control = acquireConversationControl(CONV.ativa, PAGANTE);
  try {
    const r = await post(`/conversations/${CONV.ativa}/truncate`, { messageId: `cf-msg-${stamp}` }, PAGANTE);
    assert.equal(r.status, 409);
    const row = await db.prepare('SELECT id FROM messages WHERE id=?').get(`cf-msg-${stamp}`);
    assert.ok(row, 'a mensagem continua lá');
  } finally {
    releaseConversationControl(CONV.ativa, control);
  }
});

test('ISOLAMENTO: conversa ATIVA de outro usuário responde 404 (não 409) no /chat, /truncate e /tasks', { skip: needsDb }, async () => {
  const control = acquireConversationControl(CONV.ativa, PAGANTE);
  try {
    const chat = await post(`/conversations/${CONV.ativa}/chat`, { message: 'oi' }, INTRUSO);
    assert.equal(chat.status, 404, 'um 409 revelaria que a conversa existe e está processando');
    const truncate = await post(`/conversations/${CONV.ativa}/truncate`, { messageId: 'x' }, INTRUSO);
    assert.equal(truncate.status, 404);
    const task = await post('/tasks', { conversationId: CONV.ativa, message: 'faça algo' }, INTRUSO);
    assert.equal(task.status, 404);
  } finally {
    releaseConversationControl(CONV.ativa, control);
  }
});

// ---- 12) Reserva atômica da fila de tarefas --------------------------------

test('claimQueuedTask não reabre uma tarefa cancelada no intervalo', { skip: needsDb }, async () => {
  const cancelada = `cf-task-c-${stamp}`;
  const naFila = `cf-task-q-${stamp}`;
  for (const [id, status] of [[cancelada, 'canceled'], [naFila, 'queued']]) {
    await db.prepare('INSERT INTO tasks (id,user_id,conversation_id,prompt,status,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, SEM_CHAVE, CONV.modelo, 'x', status, now());
  }
  assert.equal(await tasksModule.claimQueuedTask(cancelada), false);
  assert.equal((await db.prepare('SELECT status FROM tasks WHERE id=?').get(cancelada)).status, 'canceled');
  assert.equal(await tasksModule.claimQueuedTask(naFila), true);
  assert.equal((await db.prepare('SELECT status FROM tasks WHERE id=?').get(naFila)).status, 'running');
  assert.equal(await tasksModule.claimQueuedTask(naFila), false, 'a mesma tarefa não é reservada duas vezes');
});

// ---- 18) Modelo escolhido gravado na conversa ------------------------------

test('o modelo escolhido no /chat passa a ser o modelo da conversa', { skip: needsDb }, async () => {
  const r = await post(`/conversations/${CONV.modelo}/chat`, { message: 'olá', model: 'catalogo/modelo-escolhido' }, SEM_CHAVE);
  assert.equal(r.status, 200);
  assert.match(r.text, /"type":"done"/, 'o stream termina normalmente');
  const conv = await db.prepare('SELECT model FROM conversations WHERE id=? AND user_id=?').get(CONV.modelo, SEM_CHAVE);
  assert.equal(conv.model, 'catalogo/modelo-escolhido');
});

// ---- 4) Quarentena ---------------------------------------------------------

async function uploadTo(conversationId, name, content, user) {
  currentUser = user;
  const form = new FormData();
  form.append('files', new Blob([content]), name);
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/upload`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('antivírus degradado: o arquivo vai para a quarentena, com a linha JÁ gravada, e NÃO vira anexo', { skip: needsDb }, async () => {
  // clamd "fora do ar" (porta fechada) e não obrigatório → modo degradado.
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = '9';
  let saved;
  try {
    const r = await uploadTo(CONV.quarentena, 'nota.txt', 'conteudo nao verificado', SEM_CHAVE);
    assert.equal(r.status, 200);
    assert.equal(r.body.scanStatus, 'degradado');
    saved = r.body.files[0];
    assert.equal(saved.inQuarantine, true);
    assert.match(saved.path, /^uploads\/\.quarantine\//);
  } finally {
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
  }
  const row = await db.prepare('SELECT status, storage_path FROM quarantined_uploads WHERE id=?').get(saved.id);
  assert.ok(row, 'a linha da quarentena existe quando a resposta chega (INSERT com await)');
  assert.equal(row.storage_path, saved.path);

  // ADVERSARIAL: o cliente manda o caminho da quarentena como anexo.
  const chat = await post(`/conversations/${CONV.quarentena}/chat`, {
    message: 'analise o anexo',
    attachments: [{ name: 'nota.txt', path: saved.path }]
  }, SEM_CHAVE);
  assert.equal(chat.status, 409, 'arquivo não verificado não pode chegar à IA');
  assert.equal(chat.body.code, 'attachments_not_ready');
});

test('falha ao registrar a quarentena NÃO responde "salvo" (500 em vez de 200)', { skip: needsDb }, async () => {
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = '9';
  const original = db.prepare;
  db.prepare = function patched(sql) {
    const stmt = original.call(this, sql);
    if (/INSERT INTO quarantined_uploads/.test(sql)) {
      return { ...stmt, run: async () => { throw new Error('disco cheio'); } };
    }
    return stmt;
  };
  try {
    const r = await uploadTo(CONV.quarentena, 'outra.txt', 'x', SEM_CHAVE);
    assert.equal(r.status, 500);
  } finally {
    db.prepare = original;
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
  }
});

// ---- 7) Reconexão ao stream (GET /stream) ----------------------------------

async function readStream(route, user, timeoutMs = 3000) {
  currentUser = user;
  const res = await fetch(`${baseUrl}/api${route}`, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text(); // só resolve quando o servidor ENCERRA a resposta
  const events = text.split('\n\n').filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)));
  return { status: res.status, events };
}

test('GET /stream de run TERMINADO com cursor no fim encerra na hora (não fica pendurado)', { skip: needsDb }, async () => {
  const live = openLiveStream(CONV.stream, 'RUN-FIM');
  live.publish({ type: 'delta', content: 'resposta' }); // 1
  live.publish({ type: 'done' });                       // 2
  live.finish();
  const r = await readStream(`/conversations/${CONV.stream}/stream?runId=RUN-FIM&fromSeq=2`, PAGANTE);
  assert.equal(r.status, 200);
  assert.deepEqual(r.events, [], 'nada novo a entregar — e a conexão terminou');
});

test('GET /stream com runId ANTIGO recebe o run atual inteiro, na ordem, e termina no done', { skip: needsDb }, async () => {
  const live = openLiveStream(CONV.stream, 'RUN-NOVO');
  live.publish({ type: 'delta', content: 'a' });
  live.publish({ type: 'delta', content: 'b' });
  live.publish({ type: 'done' });
  live.finish();
  const r = await readStream(`/conversations/${CONV.stream}/stream?runId=RUN-VELHO&fromSeq=40`, PAGANTE);
  assert.deepEqual(r.events.map(e => `${e._runId}:${e._seq}:${e.type}`), ['RUN-NOVO:1:delta', 'RUN-NOVO:2:delta', 'RUN-NOVO:3:done']);
});

test('GET /stream de conversa alheia é 404, mesmo com stream vivo', { skip: needsDb }, async () => {
  openLiveStream(CONV.stream, 'RUN-X').publish({ type: 'delta', content: 'segredo' });
  currentUser = INTRUSO;
  const res = await fetch(`${baseUrl}/api/conversations/${CONV.stream}/stream`, { signal: AbortSignal.timeout(3000) });
  assert.equal(res.status, 404);
  await res.body?.cancel();
});
