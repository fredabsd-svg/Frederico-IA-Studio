// Fila do modo gratuito: todas as respostas atendidas pela chave da PLATAFORMA
// passam por aqui, com concorrência limitada (FREE_TIER_CONCURRENCY). Isso
// protege a cota compartilhada no provedor (menos 429) e dá ao usuário estados
// visíveis: "aguardando na fila", posição aproximada e cancelamento.
//
// Módulo puro (sem banco/rede) para ser testável isoladamente. Uma única fila
// global por processo — o free tier usa UMA chave compartilhada, então o
// gargalo é global mesmo.

const CONCURRENCY = Math.max(1, Number(process.env.FREE_TIER_CONCURRENCY || 2));
const QUEUE_MAX = Math.max(0, Number(process.env.FREE_TIER_QUEUE_MAX || 30));

const waiting = [];              // [{ id, resolve, reject, onPosition }]
let running = 0;

function notifyPositions() {
  waiting.forEach((job, index) => {
    try { job.onPosition?.(index + 1, waiting.length); } catch {}
  });
}

function pump() {
  while (running < CONCURRENCY && waiting.length) {
    const job = waiting.shift();
    running += 1;
    job.resolve(makeRelease());
  }
  notifyPositions();
}

function makeRelease() {
  let released = false;
  return () => {
    if (released) return;        // release é idempotente (finally + erro)
    released = true;
    running = Math.max(0, running - 1);
    pump();
  };
}

export class FreeQueueCancelled extends Error {
  constructor() { super('cancelado'); this.code = 'FREE_QUEUE_CANCELLED'; }
}
export class FreeQueueFull extends Error {
  constructor() { super('fila cheia'); this.code = 'FREE_QUEUE_FULL'; }
}

// Pede uma vaga na fila. Resolve com uma função release() quando chegar a vez;
// rejeita com FreeQueueFull (fila lotada) ou FreeQueueCancelled (cancelamento
// pelo usuário/desconexão). `id` identifica o job para cancelFreeJob (usamos o
// id da conversa). `onPosition(pos, total)` é chamado a cada movimento da fila.
export function acquireFreeSlot({ id, onPosition } = {}) {
  return new Promise((resolve, reject) => {
    if (running < CONCURRENCY && waiting.length === 0) {
      running += 1;
      resolve(makeRelease());
      return;
    }
    if (QUEUE_MAX && waiting.length >= QUEUE_MAX) { reject(new FreeQueueFull()); return; }
    waiting.push({ id, resolve, reject, onPosition });
    notifyPositions();
  });
}

// Cancela um job AINDA na fila (não interrompe o que já está processando — para
// isso existe o controle pausar/parar normal da conversa). Devolve true se
// havia algo para cancelar.
export function cancelFreeJob(id) {
  const index = waiting.findIndex(job => job.id === id);
  if (index === -1) return false;
  const [job] = waiting.splice(index, 1);
  job.reject(new FreeQueueCancelled());
  notifyPositions();
  return true;
}

export function freeQueueSnapshot() {
  return { waiting: waiting.length, running, concurrency: CONCURRENCY, max: QUEUE_MAX };
}

// Só para testes: zera o estado global da fila.
export function _resetFreeQueue() {
  waiting.splice(0).forEach(job => job.reject(new FreeQueueCancelled()));
  running = 0;
}
