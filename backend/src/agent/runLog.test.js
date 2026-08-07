// Runs duráveis (ADR 0002): as funções puras de reconstrução rodam sempre; o
// ciclo completo (gravar → reler → varrer órfãos) exige PostgreSQL e pula sem
// ele, como os demais testes de banco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, now } from '../db.js';
import { createRunLog, listConversationRuns, stepsFromRunEvents, sweepOrphanAgentRuns, toolResultLooksFailed } from './runLog.js';

let dbReady = true;
try { await pool.query('SELECT 1'); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skipReason = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';
const dbTest = (name, fn) => test(name, { skip: skipReason }, fn);

// ---- puras -------------------------------------------------------------------

test('toolResultLooksFailed segue a regra da interface (error ou exitCode ≠ 0)', () => {
  assert.equal(toolResultLooksFailed(JSON.stringify({ error: 'boom' })), true);
  assert.equal(toolResultLooksFailed(JSON.stringify({ exitCode: 2 })), true);
  assert.equal(toolResultLooksFailed(JSON.stringify({ exitCode: 0, output: 'ok' })), false);
  assert.equal(toolResultLooksFailed('texto solto'), false);
});

test('stepsFromRunEvents casa start/result e não fabrica sucesso em run interrompido', () => {
  const events = [
    { type: 'tool_start', payload: { id: 'a', name: 'bash', preview: 'npm test' }, created_at: 't1' },
    { type: 'tool_result', payload: { id: 'a', content: JSON.stringify({ exitCode: 0 }) }, created_at: 't2' },
    { type: 'tool_start', payload: { id: 'b', name: 'write_file', preview: 'x.js', detail: 'conteudo' }, created_at: 't3' }
  ];
  const steps = stepsFromRunEvents(events, { finalState: 'recoverable_error' });
  assert.equal(steps.length, 2);
  assert.equal(steps[0].status, 'done');
  assert.equal(steps[0].started, 't1');
  assert.equal(steps[0].ended, 't2');
  // A etapa sem resultado num run que NÃO concluiu é `interrupted` — nunca `done`.
  assert.equal(steps[1].status, 'interrupted');
  assert.equal(steps[1].detail, 'conteudo');
});

test('stepsFromRunEvents fecha como done etapas órfãs apenas quando o run concluiu', () => {
  const events = [{ type: 'tool_start', payload: { id: 'a', name: 'bash' }, created_at: 't1' }];
  assert.equal(stepsFromRunEvents(events, { finalState: 'completed' })[0].status, 'done');
  assert.equal(stepsFromRunEvents(events, { finalState: 'stopped' })[0].status, 'interrupted');
});

test('stepsFromRunEvents preserva subagent/parentId e marca erro pelo resultado', () => {
  const events = [
    { type: 'tool_start', payload: { id: 'c', name: 'bash', subagent: 'Revisor', parentId: 'del1' }, created_at: 't1' },
    { type: 'tool_result', payload: { id: 'c', content: JSON.stringify({ error: 'exit 1' }) }, created_at: 't2' }
  ];
  const [step] = stepsFromRunEvents(events, { finalState: 'completed' });
  assert.equal(step.subagent, 'Revisor');
  assert.equal(step.parentId, 'del1');
  assert.equal(step.status, 'error');
});

// ---- integração com banco ----------------------------------------------------

const USER = `runlog-user-${Date.now()}`;
async function seedConversation() {
  const conv = `runlog-conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const t = now();
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(USER, 'Run Log', `${USER}@teste.local`, true, t, t);
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(conv, USER, 'runlog', 'teste::modelo', t, t);
  return conv;
}

dbTest('ciclo completo: gravar eventos, fechar e reconstruir as etapas', async () => {
  const conv = await seedConversation();
  const log = createRunLog({ runId: `run-${conv}`, conversationId: conv, userId: USER, kind: 'chat' });
  log.record({ type: 'status', content: 'ruído que não persiste' });
  log.record({ type: 'delta', content: 'idem' });
  log.record({ type: 'run_state', execution: { state: 'planning', detail: 'Preparando', runId: `run-${conv}` } });
  log.record({ type: 'tool_start', id: 'a', name: 'bash', preview: 'ls' });
  log.record({ type: 'tool_result', id: 'a', name: 'bash', content: JSON.stringify({ exitCode: 0, output: 'ok' }) });
  log.record({ type: 'run_state', execution: { state: 'completed', detail: null, runId: `run-${conv}`, model: 'teste::modelo' } });
  await log.finish({ messageId: 'msg-1' });

  const runs = await listConversationRuns(USER, conv);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'completed');
  assert.equal(runs[0].messageId, 'msg-1');
  assert.equal(runs[0].model, 'teste::modelo');
  assert.ok(runs[0].endedAt, 'run fechado tem ended_at');
  assert.equal(runs[0].steps.length, 1);
  assert.equal(runs[0].steps[0].status, 'done');
  // status/delta não entram no event log
  const count = await db.prepare('SELECT COUNT(*) AS n FROM agent_run_events WHERE run_id=?').get(`run-${conv}`);
  assert.equal(Number(count.n), 4);
});

dbTest('retomada reaproveita o run e continua a sequência de eventos', async () => {
  const conv = await seedConversation();
  const runId = `run-${conv}`;
  const first = createRunLog({ runId, conversationId: conv, userId: USER });
  first.record({ type: 'tool_start', id: 'a', name: 'bash', preview: '1' });
  await first.flush();

  const resumed = createRunLog({ runId, conversationId: conv, userId: USER });
  resumed.record({ type: 'tool_result', id: 'a', name: 'bash', content: JSON.stringify({ exitCode: 0 }) });
  resumed.record({ type: 'run_state', execution: { state: 'completed', runId } });
  await resumed.finish({});

  const runs = await listConversationRuns(USER, conv);
  assert.equal(runs.length, 1, 'retomar não cria um segundo run');
  assert.equal(runs[0].steps.length, 1);
  assert.equal(runs[0].steps[0].status, 'done');
});

dbTest('finish nunca rebaixa um estado terminal e a varredura fecha órfãos', async () => {
  const conv = await seedConversation();
  const runId = `run-${conv}`;
  const log = createRunLog({ runId, conversationId: conv, userId: USER });
  log.record({ type: 'run_state', execution: { state: 'awaiting_user', detail: 'Pergunta pendente', runId } });
  await log.finish({ state: 'completed' });
  let runs = await listConversationRuns(USER, conv);
  assert.equal(runs[0].state, 'awaiting_user', 'terminal registrado pela máquina de estados prevalece');

  // Run órfão (sem ended_at): a varredura de boot marca como recoverable_error.
  const t = now();
  const orphan = `orfao-${conv}`;
  await db.prepare('INSERT INTO agent_runs (run_id,conversation_id,user_id,kind,state,started_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(orphan, conv, USER, 'chat', 'tool_running', t, t);
  const swept = await sweepOrphanAgentRuns();
  assert.ok(swept >= 1);
  runs = await listConversationRuns(USER, conv);
  const orphanRun = runs.find(run => run.runId === orphan);
  assert.equal(orphanRun.state, 'recoverable_error');
  assert.ok(orphanRun.endedAt);
});

dbTest('apagar a conversa remove runs e eventos em cascata', async () => {
  const conv = await seedConversation();
  const log = createRunLog({ runId: `run-${conv}`, conversationId: conv, userId: USER });
  log.record({ type: 'tool_start', id: 'a', name: 'bash' });
  await log.flush();
  await db.prepare('DELETE FROM conversations WHERE id=?').run(conv);
  const rows = await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE conversation_id=?').get(conv);
  assert.equal(Number(rows.n), 0);
});
