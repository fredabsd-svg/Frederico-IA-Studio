// Estado ÚNICO de controle das conversas ativas (Map "controls") — os demais
// módulos do agente importam daqui; o estado não é duplicado em outro lugar.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).

// ---- Controle de execução (pausar / continuar / parar) ----
const controls = new Map(); // conversationId -> { paused, stopped, activeRequests: Set, activeTool }

export class ConversationBusyError extends Error {
  constructor() {
    super('Esta conversa ja esta processando uma resposta.');
    this.name = 'ConversationBusyError';
    this.code = 'CONVERSATION_BUSY';
  }
}

export function acquireConversationControl(conversationId) {
  if (controls.has(conversationId)) throw new ConversationBusyError();
  // activeRequests é um Set porque o Modo Equipe consulta vários modelos EM
  // PARALELO — com um slot único, pausar/parar abortaria só a última requisição
  // e deixaria as outras rodando. Com o Set, o pause/stop aborta todas as que
  // estiverem em voo.
  const control = { paused: false, stopped: false, activeRequests: new Set(), activeTool: null };
  controls.set(conversationId, control);
  return control;
}

export function releaseConversationControl(conversationId, control) {
  if (controls.get(conversationId) === control) controls.delete(conversationId);
}

export function beginProviderRequest(control) {
  const request = new AbortController();
  control.activeRequests.add(request);
  return request;
}

export function releaseProviderRequest(control, request) {
  control?.activeRequests?.delete(request);
}

export function beginToolRequest(control) {
  const request = new AbortController();
  control.activeTool = request;
  return request;
}

export function releaseToolRequest(control, request) {
  if (control?.activeTool === request) control.activeTool = null;
}

export function controlInterruptReason(control, request) {
  if (control?.stopped) return 'stop';
  if (!request?.signal?.aborted) return null;
  const reason = request.signal.reason;
  if (reason === 'pause' || reason === 'stop') return reason;
  return control?.paused ? 'pause' : 'abort';
}

function abortActiveProviderRequest(control, reason) {
  for (const request of control?.activeRequests || []) {
    if (request && !request.signal.aborted) request.abort(reason);
  }
}

function abortActiveToolRequest(control, reason) {
  const request = control?.activeTool;
  if (request && !request.signal.aborted) request.abort(reason);
}

export function setControl(conversationId, action) {
  // Só atua sobre uma execução ATIVA; nunca cria entradas (evita vazamento
  // quando o evento chega depois que a execução terminou).
  const c = controls.get(conversationId);
  if (!c) return null;
  if (action === 'pause' && !c.stopped) {
    c.paused = true;
    abortActiveProviderRequest(c, 'pause');
  }
  else if (action === 'resume' && !c.stopped) c.paused = false;
  else if (action === 'stop') {
    c.stopped = true;
    c.paused = false;
    abortActiveProviderRequest(c, 'stop');
    abortActiveToolRequest(c, 'stop');
  }
  return c;
}
export function isConversationActive(conversationId) {
  return controls.has(conversationId);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Espera enquanto pausado; retorna true se deve PARAR
export async function gate(control, onEvent) {
  if (control.stopped) return true;
  if (control.paused) {
    onEvent({ type: 'status', content: 'Pausado' });
    while (control.paused && !control.stopped) await sleep(250);
    if (control.stopped) return true;
    onEvent({ type: 'status', content: 'Retomando...' });
  }
  return false;
}
