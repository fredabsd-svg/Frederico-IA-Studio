// Streams "ao vivo" por conversa — permitem que o cliente RECONECTE a um
// processamento que continua rodando no servidor depois que a conexão do
// front-end caiu (usuário saiu da página, minimizou no celular, oscilou a
// rede). A rota POST /chat "publica" cada evento aqui; a rota GET /stream
// "assina" e recebe primeiro o histórico do run (replay do buffer) e depois os
// eventos ao vivo — assim o usuário volta e vê o andamento como se nunca
// tivesse saído, com os botões de pausar/parar ainda funcionando.
//
// É tudo em memória e por processo: um único backend serve o app. Se um dia
// houver várias réplicas, este registro precisa virar um pub/sub compartilhado
// (Redis) — hoje seria excesso de engenharia.

const streams = new Map(); // conversationId -> LiveStream

// Limites do buffer de replay. Um run normal cabe folgado; runs muito longos
// perdem os eventos MAIS ANTIGOS (o começo da resposta), mas isso é inofensivo:
// ao terminar, o cliente recarrega a versão canônica do banco.
const MAX_EVENTS = 5000;
const MAX_BYTES = 3_000_000;
// Depois que o run termina, seguramos o buffer por um tempo para quem reconecta
// no último segundo ainda receber os eventos finais + o "done".
const GRACE_MS = 90_000;

class LiveStream {
  constructor(conversationId) {
    this.conversationId = conversationId;
    this.events = [];        // [{ seq, event, size }]
    this.seq = 0;
    this.bytes = 0;
    this.subscribers = new Set();
    this.done = false;
    this.cleanupTimer = null;
  }

  publish(event) {
    const seq = ++this.seq;
    const size = jsonSize(event);
    const rec = { seq, event, size };
    this.events.push(rec);
    this.bytes += size;
    // Descarta os mais antigos se estourar o teto (mantém sempre os recentes,
    // incluindo o "done"/"error" finais, que são os últimos a chegar).
    while (this.events.length > MAX_EVENTS || this.bytes > MAX_BYTES) {
      const dropped = this.events.shift();
      if (!dropped) break;
      this.bytes -= dropped.size;
    }
    for (const fn of this.subscribers) { try { fn(rec); } catch {} }
  }

  // Reproduz o que já passou (seq > fromSeq) e passa a receber os próximos.
  // Retorna a função para cancelar a assinatura.
  subscribe(fn, fromSeq = 0) {
    for (const rec of this.events) {
      if (rec.seq > fromSeq) { try { fn(rec); } catch {} }
    }
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  finish() {
    this.done = true;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      if (streams.get(this.conversationId) === this) streams.delete(this.conversationId);
    }, GRACE_MS);
    // Não segurar o event loop por causa da janela de carência.
    this.cleanupTimer.unref?.();
  }
}

function jsonSize(event) {
  try { return JSON.stringify(event).length; } catch { return 0; }
}

// Abre (ou reabre) o stream de uma conversa no INÍCIO de um novo run. Qualquer
// stream anterior é descartado — só existe um processamento ativo por conversa.
export function openLiveStream(conversationId) {
  const previous = streams.get(conversationId);
  if (previous?.cleanupTimer) clearTimeout(previous.cleanupTimer);
  const stream = new LiveStream(conversationId);
  streams.set(conversationId, stream);
  return stream;
}

// Recupera o stream de uma conversa para quem quer RECONECTAR. Devolve null se
// não há nada em memória (nunca rodou, ou já passou a janela de carência).
export function getLiveStream(conversationId) {
  return streams.get(conversationId) || null;
}

// Só para testes/limpeza.
export function _resetLiveStreams() {
  for (const s of streams.values()) { if (s.cleanupTimer) clearTimeout(s.cleanupTimer); }
  streams.clear();
}
