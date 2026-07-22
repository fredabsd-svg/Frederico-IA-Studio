export const EXECUTION_STATES = Object.freeze([
  'waiting', 'planning', 'analyzing', 'tool_running', 'tool_waiting',
  'processing_result', 'continuing', 'validating', 'completed', 'stopped',
  'paused', 'awaiting_user', 'recoverable_error', 'fatal_error'
]);

const TERMINAL = new Set(['completed', 'stopped', 'paused', 'awaiting_user', 'recoverable_error', 'fatal_error']);
const KNOWN = new Set(EXECUTION_STATES);

export function isTerminalExecutionState(state) {
  return TERMINAL.has(String(state || ''));
}

export function executionState(state, detail = null, extra = {}) {
  if (!KNOWN.has(state)) throw new Error(`Estado de execução desconhecido: ${state}`);
  return {
    state,
    terminal: isTerminalExecutionState(state),
    detail: detail || null,
    updatedAt: new Date().toISOString(),
    ...extra
  };
}

// O backend é a fonte de verdade. A UI pode traduzir estes estados, mas não
// deve deduzir "concluído" da ausência de tool calls ou do fim do stream.
export function emitExecutionState(onEvent, state, detail = null, extra = {}) {
  const execution = executionState(state, detail, extra);
  onEvent?.({ type: 'run_state', execution });
  return execution;
}

export function finalExecutionState({ stopped, awaitingUserReply, resumable, providerFailure, incomplete }) {
  if (stopped) return resumable ? 'paused' : 'stopped';
  if (awaitingUserReply) return 'awaiting_user';
  if (providerFailure || resumable) return 'recoverable_error';
  if (incomplete) return 'fatal_error';
  return 'completed';
}
