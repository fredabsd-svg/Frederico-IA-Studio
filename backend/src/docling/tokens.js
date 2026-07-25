// Estimativa de tokens (heurística, sem depender do tokenizer de cada provedor).
// Serve para: (a) medir a economia do Docling vs. mandar o conteúdo integral;
// (b) respeitar o limite de tokens por chunk; (c) mostrar métricas na interface.
// A regra ~4 caracteres/token é a aproximação usual para texto latino; para
// conteúdo pt-BR fica levemente conservadora, o que é seguro para orçamento.

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  // Combina densidade por caractere e por palavra e fica com a maior — evita
  // subestimar tabelas (muitos símbolos) e textos com palavras longas.
  const byChar = Math.ceil(s.length / 4);
  const byWord = Math.ceil((s.trim().split(/\s+/).filter(Boolean).length) * 1.3);
  return Math.max(byChar, byWord);
}

// Economia entre o conteúdo original (integral) e o efetivamente enviado.
export function savings(originalTokens, sentTokens) {
  const o = Math.max(0, Number(originalTokens) || 0);
  const s = Math.max(0, Number(sentTokens) || 0);
  const saved = Math.max(0, o - s);
  const percent = o > 0 ? Math.round((saved / o) * 100) : 0;
  return { originalTokens: o, sentTokens: s, savedTokens: saved, percent };
}
