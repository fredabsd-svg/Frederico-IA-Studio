// Máquina de estados EXPLÍCITA da execução do agente (Developer Workspace 3.0).
//
// O vocabulário de estados já existia (executionState.js), mas qualquer módulo
// podia emitir qualquer estado em qualquer ordem — a "máquina" real eram ~20
// flags soltas dentro do runAgent. Este módulo torna as transições um CONTRATO:
// uma tabela única diz de onde se pode ir para onde, e o rastreador
// (createRunStateTracker) é o único caminho de emissão do evento `run_state`
// dentro de um run.
//
// Política para transição inválida: em produção ela NÃO derruba o run — o
// estado é emitido mesmo assim, carimbado com `invalidTransition` e registrado
// em log. Derrubar uma tarefa do usuário por causa de um bug de rotulagem seria
// pior que o bug; o carimbo existe para o defeito aparecer em telemetria e nos
// testes, não para punir o usuário. Os testes tratam o carimbo como falha.
import { EXECUTION_STATES, executionState, isTerminalExecutionState } from './executionState.js';

const TERMINAL_STATES = EXECUTION_STATES.filter(state => isTerminalExecutionState(state));

// De onde → para onde. Todo estado NÃO terminal pode ir para qualquer terminal
// (falha, parada e conclusão podem acontecer a qualquer momento); a tabela
// lista só as transições de TRABALHO. Estados terminais não têm saída — um run
// terminado não volta a rodar (a retomada é um run novo com o MESMO runId, que
// recomeça o rastreador).
const WORK_TRANSITIONS = Object.freeze({
  // Estado inicial: o run existe mas ainda não começou a raciocinar.
  waiting: ['planning', 'analyzing'],
  // Preparação (modo desenvolvedor usa 'planning'; chat comum, 'analyzing').
  // 'tool_waiting' entra porque o ask_user pode ser a PRIMEIRA chamada do
  // primeiro passo — interceptado antes de qualquer tool_running.
  planning: ['analyzing', 'tool_running', 'continuing', 'validating', 'tool_waiting'],
  analyzing: ['tool_running', 'continuing', 'validating', 'tool_waiting'],
  // Um lote pode ter várias ferramentas: tool_running repete-se por chamada.
  tool_running: ['tool_running', 'processing_result', 'tool_waiting'],
  processing_result: ['tool_running', 'processing_result', 'continuing', 'tool_waiting', 'validating'],
  // Fim de lote / fôlego automático; 'continuing' consecutivos acontecem
  // quando uma etapa não executa ferramenta (reparo, nota de sistema).
  continuing: ['tool_running', 'continuing', 'validating', 'tool_waiting'],
  // Última parada antes do estado final.
  validating: [],
  // O modelo perguntou algo ao usuário: só resta encerrar em 'awaiting_user'.
  tool_waiting: []
});

export function canTransition(from, to) {
  if (!EXECUTION_STATES.includes(from) || !EXECUTION_STATES.includes(to)) return false;
  if (isTerminalExecutionState(from)) return false;        // terminal não tem saída
  if (isTerminalExecutionState(to)) return true;           // qualquer não-terminal pode terminar
  return (WORK_TRANSITIONS[from] || []).includes(to);
}

export function validTransitionsFrom(from) {
  if (!EXECUTION_STATES.includes(from) || isTerminalExecutionState(from)) return [];
  return [...(WORK_TRANSITIONS[from] || []), ...TERMINAL_STATES];
}

// Rastreador de estado de UM run. `to()` valida a transição, emite o evento
// `run_state` (mesmo contrato de antes — a UI não muda) e repassa o estado ao
// gravador durável (`onRecord`, ver runLog.js) quando houver um.
export function createRunStateTracker({ runId, onEvent, onRecord = null }) {
  let current = 'waiting';
  let invalidCount = 0;
  return {
    get state() { return current; },
    get invalidTransitions() { return invalidCount; },
    to(state, detail = null, extra = {}) {
      const from = current;
      const valid = canTransition(from, state);
      if (!valid) {
        invalidCount += 1;
        console.warn(`[run-state] transição inválida ${from} -> ${state} (run ${runId || 'sem-id'})`);
      }
      current = state;
      const execution = executionState(state, detail, {
        ...(runId ? { runId } : {}),
        ...extra,
        ...(valid ? {} : { invalidTransition: { from } })
      });
      onEvent?.({ type: 'run_state', execution });
      try { onRecord?.(execution); } catch { /* durabilidade nunca derruba o run */ }
      return execution;
    }
  };
}
