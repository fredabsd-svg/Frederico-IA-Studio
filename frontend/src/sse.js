function parseFrame(frame) {
  const data = String(frame || '')
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

// Returns complete JSON SSE events and leaves an incomplete final frame in
// `rest`. Passing flush=true consumes that final frame when the stream closes.
export function takeSseEvents(buffer, { flush = false } = {}) {
  const frames = String(buffer || '').split(/\r?\n\r?\n/);
  const rest = flush ? '' : (frames.pop() || '');
  const complete = flush ? frames : frames;
  return {
    events: complete.map(parseFrame).filter(Boolean),
    rest
  };
}
