// Coordenador durável de pipelines multimodelo (F-15).
//
// Estado serializável de uma execução multiModel em andamento — persiste
// no Postgres para que um kill-9 ou restart do backend não descarte o
// progresso dos estágios anteriores. Sem isto, o usuário paga o custo de
// cada modelo novamente a cada restart.
//
// O `state_json` carrega o que cabe no coordenador: configuração, status de
// cada slot/round, e os artefatos parciais. NÃO leva o histórico completo
// de mensagens de cada modelo — isso iria estourar a coluna JSONB e ainda
// não é necessário: o resultado final (texto consolidado + arquivos) é o
// que importa para retomada.
import { db, now } from '../db.js';
import { nanoid } from 'nanoid';

const GRACE_MS = 90_000; // mesma janela de carência do liveStream

export class PipelineRunConflictError extends Error {
  constructor(conversationId) {
    super('Já existe um pipeline ativo nesta conversa. Continue ou cancele a execução salva antes de iniciar outra.');
    this.name = 'PipelineRunConflictError';
    this.code = 'PIPELINE_RUN_ACTIVE';
    this.conversationId = conversationId;
  }
}

export class PipelineRunScopeError extends Error {
  constructor() {
    super('O escopo de usuário é obrigatório para acessar um pipeline.');
    this.name = 'PipelineRunScopeError';
    this.code = 'PIPELINE_RUN_SCOPE_REQUIRED';
  }
}

function requireScope(userId) {
  if (!userId) throw new PipelineRunScopeError();
}

function isActiveRunConflict(err) {
  return err?.code === '23505' && err?.constraint === 'uniq_pipeline_runs_active';
}

function parseJSON(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function newPipelineRunId() {
  return `pipe_${nanoid(16)}`;
}

// Cria uma linha nova para o run. A persistência é parte da admissão: sem a
// reserva durável, o pipeline NÃO começa. Isso faz o índice parcial da migration
// 027 funcionar como exclusão mútua também entre processos/restarts.
export async function createPipelineRun({ conversationId, userId, mode, totalStages, config, state = {}, rounds = 1 }) {
  requireScope(userId);
  if (!conversationId || !mode) throw new TypeError('conversationId e mode são obrigatórios para criar um pipeline.');
  const id = newPipelineRunId();
  const t = now();
  try {
    await db.prepare(`
      INSERT INTO pipeline_runs
        (pipeline_run_id, conversation_id, user_id, mode, status, current_stage, total_stages, rounds_run, config_json, state_json, started_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', 0, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, userId, mode, Math.max(1, Number(totalStages) || 1), Math.max(1, Number(rounds) || 1), JSON.stringify(config || {}), JSON.stringify(state || {}), t, t);
    return id;
  } catch (err) {
    if (isActiveRunConflict(err)) throw new PipelineRunConflictError(conversationId);
    throw err;
  }
}

// Atualiza o estado após uma fronteira de estágio/round. Pode ser chamado
// múltiplas vezes — o último estado gravado é o que vale para a retomada.
export async function updatePipelineRun(pipelineRunId, userId, patch = {}) {
  requireScope(userId);
  if (!pipelineRunId) return false;
  const sets = [];
  const values = [];
  if ('currentStage' in patch) { sets.push('current_stage=?'); values.push(Math.max(0, Number(patch.currentStage) || 0)); }
  if ('roundsRun' in patch) { sets.push('rounds_run=?'); values.push(Math.max(1, Number(patch.roundsRun) || 1)); }
  if ('status' in patch) { sets.push('status=?'); values.push(String(patch.status)); }
  if ('state' in patch && patch.state !== undefined) { sets.push('state_json=?'); values.push(JSON.stringify(patch.state || {})); }
  if ('completedAt' in patch) { sets.push('completed_at=?'); values.push(String(patch.completedAt)); }
  if (!sets.length) return false;
  sets.push('updated_at=?'); values.push(now());
  values.push(pipelineRunId, userId);
  const result = await db.prepare(`UPDATE pipeline_runs SET ${sets.join(', ')} WHERE pipeline_run_id=? AND user_id=?`).run(...values);
  return Number(result?.changes || 0) === 1;
}

// Carrega um pipeline run. Devolve { id, mode, status, currentStage,
// totalStages, roundsRun, config, state } ou null.
export async function loadPipelineRun(conversationId, userId, { includeTerminal = false } = {}) {
  requireScope(userId);
  if (!conversationId) return null;
  const where = includeTerminal
      ? 'conversation_id=? AND user_id=?'
      : "conversation_id=? AND user_id=? AND status='running'";
  const row = await db.prepare(
    `SELECT pipeline_run_id, mode, status, current_stage, total_stages, rounds_run, config_json, state_json, started_at, updated_at, completed_at
     FROM pipeline_runs WHERE ${where} ORDER BY started_at DESC LIMIT 1`
  ).get(conversationId, userId);
  if (!row) return null;
  return {
    id: row.pipeline_run_id,
    mode: row.mode,
    status: row.status,
    currentStage: Number(row.current_stage || 0),
    totalStages: Number(row.total_stages || 0),
    roundsRun: Number(row.rounds_run || 1),
    config: parseJSON(row.config_json, {}),
    state: parseJSON(row.state_json, {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

// Marca como terminal. completedAt = agora; o sweeper apaga depois de GRACE_MS.
export async function completePipelineRun(pipelineRunId, userId, { status = 'done' } = {}) {
  if (!['done', 'stopped', 'error'].includes(status)) status = 'done';
  return updatePipelineRun(pipelineRunId, userId, { status, completedAt: now() });
}

// Cancela um coordenador persistente quando não existe mais processo vivo no
// Map local (caso típico: restart). A atualização atômica evita read-then-write.
export async function stopActivePipelineRun(conversationId, userId) {
  requireScope(userId);
  if (!conversationId) return false;
  const t = now();
  const result = await db.prepare(`
    UPDATE pipeline_runs
       SET status='stopped', completed_at=?, updated_at=?
     WHERE conversation_id=? AND user_id=? AND status='running'
  `).run(t, t, conversationId, userId);
  return Number(result?.changes || 0) > 0;
}

// Remove linhas terminais com mais de GRACE_MS. Defensivo: roda em erro.
// Retorna o número de linhas removidas.
export async function sweepStalePipelineRuns({ olderThanMs = GRACE_MS, nowMs = Date.now() } = {}) {
  try {
    const cutoff = new Date(nowMs - olderThanMs).toISOString();
    const r = await db.prepare(
      "DELETE FROM pipeline_runs WHERE status IN ('done', 'stopped', 'error') AND completed_at IS NOT NULL AND completed_at < ?"
    ).run(cutoff);
    return Number(r?.changes || 0);
  } catch { return 0; }
}

// Para testes / CLI: zera o estado.
export async function _resetPipelineRunsForTests() {
  try { await db.prepare('DELETE FROM pipeline_runs').run(); } catch {}
}
