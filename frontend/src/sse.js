function parseFrame(frame) {
  const data = String(frame || '')
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

// WHY: frames sem `data:` (heartbeat `: ping`) viram null e saem do filtro —
// comentários SSE não podem virar eventos nem travar o parser.
// Returns complete JSON SSE events and leaves an incomplete final frame in
// `rest`. Passing flush=true consumes that final frame when the stream closes
// (proxies sometimes omit the trailing blank line on the last event).
export function takeSseEvents(buffer, { flush = false } = {}) {
  const frames = String(buffer || '').split(/\r?\n\r?\n/);
  // WHY: sem flush, o último pedaço pode estar incompleto — fica em `rest`.
  // Com flush (EOF), esse pedaço é o evento final e tem de ser parseado.
  const rest = flush ? '' : (frames.pop() || '');
  return {
    events: frames.map(parseFrame).filter(Boolean),
    rest
  };
}
