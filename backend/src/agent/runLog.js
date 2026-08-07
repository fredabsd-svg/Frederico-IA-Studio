// Gravador durável de runs do agente (ADR 0002).
//
// Cada execução (POST /chat, /resume) cria um `createRunLog` na ROTA — o único
// ponto por onde TODOS os eventos passam (agente único, multimodelo,
// orquestrador e os eventos repassados dos sub-agentes). O gravador persiste em
// `agent_runs`/`agent_run_events` os eventos que permitem reconstruir a
// execução depois de um reload ou de um restart do backend.
//
// Princípios:
//  - a durabilidade NUNCA derruba o run: toda falha de escrita é logada e o
//    gravador se desliga (o run segue ao vivo, só perde o histórico durável);
//  - as escritas são serializadas numa corrente de promises (ordem garantida,
//    sem transação longa) e o chamador não espera por elas;
//  - eventos de alta frequência (delta, status, tool_progress) NÃO são
//    persistidos — o event log guarda a ESTRUTURA da execução, não o stream.
import { db, now } from '../db.js';
import { isTerminalExecutionState } from './executionState.js';

// Eventos que valem reconstrução. `run_state` também atualiza a linha do run.
const PERSISTED_EVENTS = new Set([
  'tool_start', 'tool_result', 'run_state', 'input_required', 'plan_update', 'files', 'file_checks'
]);
// Teto do payload serializado de UM evento. Acima disso o evento é gravado
// truncado com aviso — nunca descartado em silêncio.
const MAX_PAYLOAD_CHARS = 16_000;
// Teto de eventos por run: um run legítimo tem dezenas/centenas de eventos
// estruturais; milhares indicam loop — paramos de gravar (com aviso único) para
// não transformar um bug em pressão de disco.
const MAX_EVENTS_PER_RUN = 5000;

function serializePayload(event) {
  const { type, ...payload } = event;
  let json;
  try { json = JSON.stringify(payload); } catch { json = '{}'; }
  if (json.length > MAX_PAYLOAD_CHARS) {
    const slim = { truncated: true, note: `payload de ${json.length} chars truncado pelo run log` };
    if (typeof payload.content === 'string') slim.content = payload.content.slice(0, 2000);
    if (payload.id) slim.id = payload.id;
    if (payload.name) slim.name = payload.name;
    json = JSON.stringify(slim);
  }
  return json;
}

export function createRunLog({ runId, conversationId, userId, kind = 'chat' }) {
  let seq = 0;
  let disabled = false;
  let warnedLimit = false;
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    if (disabled) return chain;
    chain = chain.then(fn).catch((err) => {
      if (!disabled) {
        disabled = true;
        console.error(`[run-log] gravação desligada para o run ${runId}:`, err.message);
      }
    });
    return chain;
  };

  // Linha do run. Na RETOMADA o runId já existe: mantemos started_at e o kind
  // originais e continuamos a sequência de eventos do ponto onde parou.
  enqueue(async () => {
    const t = now();
    await db.prepare(`
      INSERT INTO agent_runs (run_id, conversation_id, user_id, kind, state, started_at, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (run_id) DO UPDATE SET updated_at=EXCLUDED.updated_at, ended_at=NULL
    `).run(runId, conversationId, userId, kind, 'waiting', t, t);
    const row = await db.prepare('SELECT MAX(seq) AS max FROM agent_run_events WHERE run_id=?').get(runId);
    seq = Number(row?.max) || 0;
  });

  return {
    get runId() { return runId; },
    // Chamado para TODO evento do stream; filtra e grava só os estruturais.
    record(event) {
      const type = event?.type;
      if (disabled || !type || !PERSISTED_EVENTS.has(type)) return;
      enqueue(async () => {
        seq += 1;
        if (seq > MAX_EVENTS_PER_RUN) {
          if (!warnedLimit) {
            warnedLimit = true;
            console.warn(`[run-log] run ${runId} passou de ${MAX_EVENTS_PER_RUN} eventos; os demais não serão persistidos.`);
          }
          return;
        }
        const t = now();
        await db.prepare('INSERT INTO agent_run_events (run_id, seq, type, payload, created_at) VALUES (?,?,?,?,?)')
          .run(runId, seq, type, serializePayload(event), t);
        if (type === 'run_state' && event.execution?.state) {
          await db.prepare('UPDATE agent_runs SET state=?, detail=?, model=COALESCE(?, model), updated_at=? WHERE run_id=?')
            .run(event.execution.state, event.execution.detail || null, event.execution.model || null, t, runId);
        }
      });
    },
    // Fecha o run. Se a máquina de estados já registrou um estado terminal, ele
    // fica; senão vale o `state` informado (ou 'completed'). Nunca sobrescreve
    // um terminal com outro — o run_state final é a autoridade.
    finish({ state = null, detail = null, messageId = null } = {}) {
      enqueue(async () => {
        const t = now();
        const row = await db.prepare('SELECT state FROM agent_runs WHERE run_id=?').get(runId);
        const current = row?.state || 'waiting';
        const finalState = isTerminalExecutionState(current) ? current : (state || 'completed');
        await db.prepare('UPDATE agent_runs SET state=?, detail=COALESCE(?, detail), message_id=COALESCE(?, message_id), ended_at=?, updated_at=? WHERE run_id=?')
          .run(finalState, detail, messageId, t, t, runId);
      });
      return chain;
    },
    // Só para testes: espera a corrente de escrita drenar.
    flush() { return chain; }
  };
}

// Varredura de boot: um run sem `ended_at` após um restart é um run que MORREU
// com o processo. Marcá-lo como erro recuperável é o que permite à UI dizer a
// verdade ("o servidor reiniciou durante a execução") em vez de exibir uma
// execução eternamente "rodando". Roda antes de o servidor aceitar tráfego.
export async function sweepOrphanAgentRuns() {
  try {
    const t = now();
    const result = await db.prepare(`
      UPDATE agent_runs
      SET state='recoverable_error', detail='O servidor foi reiniciado durante a execução.', ended_at=?, updated_at=?
      WHERE ended_at IS NULL
    `).run(t, t);
    const count = result?.changes ?? result?.rowCount ?? 0;
    if (count) console.warn(`[run-log] ${count} run(s) órfão(s) de um restart marcados como recoverable_error.`);
    return count;
  } catch (err) {
    console.error('[run-log] varredura de runs órfãos falhou:', err.message);
    return 0;
  }
}

// ---- Leitura: reconstrução das etapas para a interface -----------------------

// Mesma regra do frontend (useChat.toolResultFailed): o resultado indica falha
// quando traz `error` ou exitCode ≠ 0. Centralizada aqui para a reconstrução
// pós-reload não divergir do que a UI mostrou ao vivo.
export function toolResultLooksFailed(content) {
  try {
    const parsed = JSON.parse(String(content || ''));
    if (parsed && typeof parsed === 'object') {
      if (parsed.error) return true;
      if (Number.isFinite(parsed.exitCode) && parsed.exitCode !== 0) return true;
    }
  } catch { /* texto solto não é falha */ }
  return false;
}

// Reduz o event log de um run às ETAPAS que a interface exibe (mesma forma dos
// blocos de ferramenta do useChat). Pura — testável sem banco.
// Etapa sem `tool_result` num run que não concluiu é marcada `interrupted`:
// dizer "done" seria o sucesso falso que a Regra 4.2 proíbe.
export function stepsFromRunEvents(events, { finalState = null } = {}) {
  const steps = [];
  const open = new Map();
  for (const record of events || []) {
    const payload = record.payload || {};
    if (record.type === 'tool_start') {
      const step = {
        id: payload.id || null,
        name: payload.name || '',
        preview: payload.preview || '',
        ...(payload.detail ? { detail: payload.detail } : {}),
        ...(payload.subagent ? { subagent: payload.subagent } : {}),
        ...(payload.parentId ? { parentId: payload.parentId } : {}),
        status: 'running',
        started: record.created_at || null
      };
      steps.push(step);
      if (step.id) open.set(step.id, step);
    } else if (record.type === 'tool_result') {
      const step = payload.id ? open.get(payload.id) : null;
      if (!step) continue;
      step.status = toolResultLooksFailed(payload.content) ? 'error' : 'done';
      step.ended = record.created_at || null;
      step.result = payload.content || '';
      if (payload.thumb) step.thumb = payload.thumb;
      open.delete(payload.id);
    }
  }
  if (open.size) {
    const finished = finalState === 'completed';
    for (const step of open.values()) step.status = finished ? 'done' : 'interrupted';
  }
  return steps;
}

// Runs de uma conversa com etapas/plano reconstruídos — o que o frontend usa
// para remontar o terminal e a atividade depois de um reload.
export async function listConversationRuns(userId, conversationId, { limit = 20 } = {}) {
  let runs;
  try {
    runs = await db.prepare(`
      SELECT run_id, kind, state, detail, model, message_id, started_at, updated_at, ended_at
      FROM agent_runs WHERE conversation_id=? AND user_id=?
      ORDER BY started_at DESC LIMIT ?
    `).all(conversationId, userId, limit);
  } catch (err) {
    console.error('[run-log] leitura de runs falhou:', err.message);
    return [];
  }
  const result = [];
  for (const run of runs) {
    let events = [];
    try {
      events = await db.prepare('SELECT seq, type, payload, created_at FROM agent_run_events WHERE run_id=? ORDER BY seq ASC LIMIT ?')
        .all(run.run_id, MAX_EVENTS_PER_RUN);
    } catch (err) {
      console.error('[run-log] leitura de eventos falhou:', err.message);
    }
    const parsed = events.map(row => {
      let payload = {};
      try { payload = JSON.parse(row.payload); } catch {}
      return { seq: row.seq, type: row.type, payload, created_at: row.created_at };
    });
    const planEvents = parsed.filter(record => record.type === 'plan_update');
    result.push({
      runId: run.run_id,
      kind: run.kind,
      state: run.state,
      detail: run.detail || null,
      model: run.model || null,
      messageId: run.message_id || null,
      startedAt: run.started_at,
      endedAt: run.ended_at || null,
      steps: stepsFromRunEvents(parsed, { finalState: run.state }),
      plan: planEvents.length ? (planEvents[planEvents.length - 1].payload.plan || null) : null
    });
  }
  return result;
}
