// Detecção de erros recorrentes (seção 6.8: «o mesmo erro apareceu 5 vezes»).
// Lógica PURA e testável: normaliza uma linha de log/erro numa "assinatura"
// estável (removendo timestamps, números, hex, caminhos e aspas variáveis) e
// conta ocorrências por assinatura numa janela de tempo. Quando uma assinatura
// cruza o limiar, vira um alerta — uma única vez, até ser reconhecido.

// Normaliza uma linha em uma assinatura estável para agrupar variações do
// "mesmo" erro (ex.: mesma exceção com IDs/horas diferentes).
export function signatureOf(line) {
  let s = String(line || '').trim();
  if (!s) return '';
  s = s
    .replace(/\b\d{4}-\d{2}-\d{2}[t ][\d:.,z+-]*/gi, '<ts>')     // datas/horas ISO
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/g, '<time>')     // horas soltas
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')                        // hex
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')                      // hashes/ids longos
    .replace(/\b\d+\b/g, '<n>')                                   // números
    .replace(/(["'`])(?:\\.|[^\\])*?\1/g, '<str>')                // literais entre aspas
    .replace(/\/[^\s:]+/g, '<path>')                              // caminhos
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  return s.slice(0, 200);
}

// Heurística: a linha parece um erro? (evita alertar sobre logs comuns)
export function looksLikeError(line) {
  // Sem \b no fim: códigos como ECONNREFUSED/EADDRINUSE colam o sufixo na
  // palavra-chave e um boundary final os perderia.
  return /\b(error|erro|exception|exceç|fail|falh|fatal|panic|traceback|refus|recusad|timeout|econn|eaddr|enoent|denied|negad|cannot|não\s+consegui|unhandled|segfault|stack\s?trace)/i
    .test(String(line || ''));
}

// Acumulador em memória por usuário. Mantém, por assinatura, os horários (ms)
// das ocorrências dentro da janela e se já alertamos por ela.
export class ErrorDigest {
  constructor({ threshold = 3, windowMs = 10 * 60 * 1000, maxSignatures = 200 } = {}) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.maxSignatures = maxSignatures;
    this.map = new Map(); // sig -> { hits: number[], sample: string, alerted: boolean }
  }

  // Adiciona linhas e devolve as assinaturas que ACABARAM de cruzar o limiar
  // (para virarem alerta). nowMs é injetável para testes determinísticos.
  add(lines, nowMs = Date.now()) {
    const fired = [];
    const list = Array.isArray(lines) ? lines : [lines];
    for (const raw of list) {
      if (!looksLikeError(raw)) continue;
      const sig = signatureOf(raw);
      if (!sig) continue;
      let entry = this.map.get(sig);
      if (!entry) {
        if (this.map.size >= this.maxSignatures) this.#evictOldest(nowMs);
        entry = { hits: [], sample: String(raw).trim().slice(0, 300), alerted: false };
        this.map.set(sig, entry);
      }
      entry.hits.push(nowMs);
      // Descarta ocorrências fora da janela.
      const cutoff = nowMs - this.windowMs;
      entry.hits = entry.hits.filter(t => t >= cutoff);
      if (!entry.alerted && entry.hits.length >= this.threshold) {
        entry.alerted = true;
        fired.push({ signature: sig, count: entry.hits.length, sample: entry.sample });
      }
    }
    return fired;
  }

  // Rearma uma assinatura (ex.: usuário resolveu/dispensou o alerta): pode
  // alertar de novo se voltar a recorrer.
  reset(signature) { this.map.delete(signature); }

  #evictOldest(nowMs) {
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of this.map) {
      const last = v.hits[v.hits.length - 1] ?? 0;
      if (last < oldest) { oldest = last; oldestKey = k; }
    }
    if (oldestKey) this.map.delete(oldestKey);
  }
}
