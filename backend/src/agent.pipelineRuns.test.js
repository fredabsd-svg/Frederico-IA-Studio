// F-15: coordenador durável de pipelines multimodelo. Cobre as primitivas
// puras de save/load/update/complete E a integração com runMultiModel
// (retomada após boot, cancelamento sem órfão, preservação de config).
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

// ---- F-15: INTEGRAÇÃO com runMultiModel ----
// Estes testes provam que o coordenador durável sobrevive a um boot (pool novo)
// e retoma do estágio correto sem repetir estágios já concluídos. O cenário
// real é: backend grava currentStage=1 + state entre as etapas 1 e 2, recebe
// kill -9, e o próximo processo carrega o run e retoma da etapa 2.

t('retoma do estágio correto após simulação de boot (pool novo)', async () => {
  const conv = nextConv();
  const modelConfig = {
    mode: 'pipeline',
    models: [
      { id: 'openai/gpt-4o', role: 'arquiteto' },
      { id: 'anthropic/claude-3.7-sonnet', role: 'implementador' },
      { id: 'google/gemini-2.0-flash-001', role: 'revisor' }
    ],
    coordinator: 'openai/gpt-4o',
    rounds: 1, context: 'recent'
  };
  // Cria o run como se o backend tivesse acabado de iniciar o pipeline.
  const id = await createPipelineRun({
    conversationId: conv, userId: USER,
    mode: 'pipeline', totalStages: 3, config: modelConfig
  });
  assert.ok(id, 'criar deve devolver id');
  // Estado após completar a etapa 0 (arquiteto).
  const stateAfterStage0 = {
    artifactRunId: 'pipeline_abc123',
    completedStages: [
      { slot: 0, text: 'Plano de implementação: 3 etapas.', name: 'GPT-4o', roleLabel: 'Arquiteto de software' }
    ],
    artifactOutputPaths: []
  };
  await updatePipelineRun(id, { currentStage: 1, state: stateAfterStage0 });

  // Simula BOOT: carrega o run de um "pool novo". O loadPipelineRun lê do
  // banco — é exatamente o que acontece quando o processo sobe do zero.
  const loaded = await loadPipelineRun(conv);
  assert.ok(loaded, 'deve carregar o run ativo após o boot');
  assert.equal(loaded.currentStage, 1, 'currentStage deve ser 1 (etapa 0 concluída)');
  assert.equal(loaded.totalStages, 3);
  assert.equal(loaded.status, 'running');
  assert.deepEqual(loaded.config, modelConfig);
  assert.equal(loaded.state.artifactRunId, 'pipeline_abc123');
  assert.equal(loaded.state.completedStages.length, 1);
  assert.equal(loaded.state.completedStages[0].slot, 0);
  assert.equal(loaded.state.completedStages[0].name, 'GPT-4o');

  // O próximo estágio a executar é o 1 (implementador). A lógica de resume
  // em runMultiModel usa currentStage como índice do próximo executável.
  // Ex.: se resumeFromStage = loaded.currentStage (= 1), o loop começa em
  // executableIndex = 1, pulando o estágio 0 já concluído.

  await completePipelineRun(id, { status: 'done' });
});

t('cancelamento não deixa run running órfão', async () => {
  const conv = nextConv();
  const id = await createPipelineRun({
    conversationId: conv, userId: USER,
    mode: 'pipeline', totalStages: 2, config: { mode: 'pipeline', models: [{ id: 'a/b' }, { id: 'c/d' }] }
  });
  // Usuário cancela — o finally do runMultiModel chama completePipelineRun
  // com status 'stopped'.
  await completePipelineRun(id, { status: 'stopped' });

  // loadPipelineRun SEM includeTerminal NÃO deve devolver runs parados.
  const active = await loadPipelineRun(conv);
  assert.equal(active, null, 'run stopped não deve aparecer como ativo');

  // Com includeTerminal, deve aparecer.
  const terminal = await loadPipelineRun(conv, { includeTerminal: true });
  assert.equal(terminal.status, 'stopped');
  assert.ok(terminal.completedAt, 'completedAt definido');
});

t('falha completa o run como error (sem órfão)', async () => {
  const conv = nextConv();
  const id = await createPipelineRun({
    conversationId: conv, userId: USER,
    mode: 'pipeline', totalStages: 2, config: { mode: 'pipeline', models: [{ id: 'a/b' }, { id: 'c/d' }] }
  });
  await completePipelineRun(id, { status: 'error' });

  const active = await loadPipelineRun(conv);
  assert.equal(active, null, 'run com error não deve aparecer como ativo');

  const terminal = await loadPipelineRun(conv, { includeTerminal: true });
  assert.equal(terminal.status, 'error');
});

t('config_json preserva a configuração completa entre save/load', async () => {
  const conv = nextConv();
  const fullConfig = {
    mode: 'pipeline',
    models: [
      { id: 'openai/gpt-4o', role: 'principal' },
      { id: 'deepseek/deepseek-chat', role: 'revisor', prompt: 'revise com atenção' }
    ],
    coordinator: 'openai/gpt-4o',
    rounds: 1,
    context: 'recent',
    maxTokensPerModel: 4096,
    budgetUsd: 5.0
  };
  const id = await createPipelineRun({
    conversationId: conv, userId: USER,
    mode: 'pipeline', totalStages: 2, config: fullConfig
  });
  const loaded = await loadPipelineRun(conv);
  assert.deepEqual(loaded.config, fullConfig, 'config deve ser preservado integralmente');
  await completePipelineRun(id, { status: 'done' });
});

t('run órfão em running NUNCA é varrido pelo sweeper — o fechamento explícito é obrigatório', async () => {
  // Um kill-9 no meio de um pipeline deixa o run em `running` sem completed_at.
  // O sweeper só apaga runs TERMINAIS, de propósito (apagar um running seria
  // destruir uma execução viva). Consequência: se nada fechar o órfão, ele
  // fica `running` para sempre e `loadPipelineRun` o devolve para qualquer
  // mensagem futura — o sequestro que `runMultiModel` evita fechando o órfão
  // como `error` quando chega mensagem NOVA (retomar é papel exclusivo do
  // /resume, que passa `pipelineResume` explicitamente).
  const conv = nextConv();
  const id = await createPipelineRun({
    conversationId: conv, userId: USER,
    mode: 'pipeline', totalStages: 3, config: { mode: 'pipeline', models: [] }
  });

  // Mesmo com uma janela de carência gigante, o running sobrevive ao sweeper.
  await sweepStalePipelineRuns({ olderThanMs: 0, nowMs: Date.now() + 86_400_000 });
  const aindaVivo = await loadPipelineRun(conv);
  assert.equal(aindaVivo?.id, id, 'o sweeper não pode apagar um run em running');

  // O caminho da mensagem nova: fecha como error e o run some do "ativo".
  await completePipelineRun(id, { status: 'error' });
  assert.equal(await loadPipelineRun(conv), null, 'órfão fechado não é mais herdado');
  const terminal = await loadPipelineRun(conv, { includeTerminal: true });
  assert.equal(terminal.status, 'error');
});
