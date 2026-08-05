// F-15: coordenador durável de pipelines multimodelo. Cobre as primitivas
// puras de save/load/update/complete. A integração com runMultiModel
// (atualizar currentStage entre estágios) é o próximo passo; aqui
// provamos que o banco É a fonte de verdade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool } from './db.js';
import {
  createPipelineRun, updatePipelineRun, loadPipelineRun,
  completePipelineRun, sweepStalePipelineRuns, newPipelineRunId
} from './agent/pipelineRuns.js';

let dbReady = true;
try { await pool.query('SELECT 1'); } catch { dbReady = false; }
// As migrações rodam AQUI, como nos demais testes de banco: os arquivos de
// teste correm em paralelo e nenhum pode contar com outro para preparar o
// schema. Sem esta linha o resultado depende da ordem de execução — passa na
// suíte completa (algum vizinho migrou antes) e falha no job da contagem.
if (dbReady) { const { runMigrations } = await import('./migrate.js'); await runMigrations(); }
const skipReason = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';
const t = (name, fn) => test(name, { skip: skipReason }, fn);

const USER = 'f15-user';
const CONV_PREFIX = 'f15-conv-';
let seq = 0;
function nextConv() { return `${CONV_PREFIX}${Date.now()}-${++seq}`; }

t('cria run com id único e total_stages correto', async () => {
  const conv = nextConv();
  const id = await createPipelineRun({
    conversationId: conv, userId: USER, mode: 'pipeline',
    totalStages: 3, config: { models: ['m1', 'm2', 'm3'] }
  });
  assert.ok(id, 'criar deve devolver id');
  assert.ok(id.startsWith('pipe_'), 'id deve ter prefixo pipe_');
});

t('atualiza currentStage e persiste state', async () => {
  const conv = nextConv();
  const id = await createPipelineRun({
    conversationId: conv, userId: USER, mode: 'compare',
    totalStages: 2, config: { models: ['a', 'b'] }
  });
  await updatePipelineRun(id, { currentStage: 1, state: { slot1: 'done' } });
  const loaded = await loadPipelineRun(conv);
  assert.equal(loaded.currentStage, 1);
  assert.equal(loaded.state.slot1, 'done');
});

t('loadPipelineRun sem run ativo devolve null', async () => {
  const conv = nextConv();
  const loaded = await loadPipelineRun(conv);
  assert.equal(loaded, null);
});

t('completePipelineRun muda status para terminal e seta completedAt', async () => {
  const conv = nextConv();
  const id = await createPipelineRun({
    conversationId: conv, userId: USER, mode: 'council',
    totalStages: 2, config: {}
  });
  await completePipelineRun(id, { status: 'done' });
  const loaded = await loadPipelineRun(conv, { includeTerminal: true });
  assert.equal(loaded.status, 'done');
  assert.ok(loaded.completedAt, 'completedAt deve estar preenchido');
  // Sem includeTerminal, runs terminais SOMEM do load padrão (a janela
  // de carência serve para reconexão SSE, não para retomada).
  const active = await loadPipelineRun(conv);
  assert.equal(active, null);
});

t('sweepStalePipelineRuns remove terminais antigos mas preserva recentes', async () => {
  const conv = nextConv();
  const id = await createPipelineRun({
    conversationId: conv, userId: USER, mode: 'pipeline',
    totalStages: 1, config: {}
  });
  // Completa com completedAt NO PASSADO (2 minutos atrás) — acima do grace.
  await db.prepare(
    "UPDATE pipeline_runs SET status='done', completed_at=? WHERE pipeline_run_id=?"
  ).run(new Date(Date.now() - 5 * 60_000).toISOString(), id);

  const removed = await sweepStalePipelineRuns({ olderThanMs: 60_000 });
  assert.ok(removed >= 1, `esperava >= 1 remoção; recebi ${removed}`);

  // Outro run, recém-completado: NÃO deve ser removido.
  const conv2 = nextConv();
  const id2 = await createPipelineRun({
    conversationId: conv2, userId: USER, mode: 'pipeline',
    totalStages: 1, config: {}
  });
  await completePipelineRun(id2, { status: 'done' });
  const removed2 = await sweepStalePipelineRuns({ olderThanMs: 60_000 });
  assert.equal(removed2, 0, 'run recém-completado não deve ser removido');

  // Limpeza
  await db.prepare("DELETE FROM pipeline_runs WHERE pipeline_run_id=?").run(id2);
});

t('updatePipelineRun com patch vazio é no-op', async () => {
  const r = await updatePipelineRun('inexistente', {});
  assert.equal(r, false);
});

t('newPipelineRunId devolve ids únicos', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(newPipelineRunId());
  assert.equal(ids.size, 100, 'todos os 100 ids devem ser únicos');
});
