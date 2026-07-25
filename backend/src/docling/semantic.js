// Seleção de trechos por SIMILARIDADE (embeddings) — critério de aceite nº 9:
// enviar só os trechos relevantes. Reusa a infra de embeddings do app (a mesma
// da memória/RAG). Aqui fica só a lógica pura de ranqueamento (cosseno injetado,
// para testar sem carregar modelo); a geração dos vetores vive no service/context.
import { estimateTokens } from './tokens.js';

// Ranqueia os chunks pela similaridade com o vetor da pergunta e preenche até o
// orçamento de tokens. `vectors[i]` é o vetor do chunk i (ou null); `cosineFn`
// compara dois vetores. Chunks sem vetor recebem score baixo (vão para o fim).
// Retorna os escolhidos reordenados pela posição no documento (leitura natural).
export function rankBySimilarity(chunks, vectors, queryVec, tokenBudget, cosineFn) {
  const list = Array.isArray(chunks) ? chunks : [];
  const scored = list.map((c, i) => ({
    c, i,
    score: (queryVec && vectors && vectors[i]) ? cosineFn(queryVec, vectors[i]) : -1,
  }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const picked = [];
  let used = 0;
  for (const s of scored) {
    const t = s.c.tokens || estimateTokens(s.c.content);
    if (used + t > tokenBudget && picked.length) continue;
    picked.push(s.c);
    used += t;
    if (used >= tokenBudget) break;
  }
  return picked.sort((a, b) => (a.page - b.page) || 0);
}

// Texto que representa um chunk para embedding (seção + conteúdo, limitado).
export function chunkEmbedText(c) {
  return `${c.section || ''}\n${c.content || ''}`.slice(0, 2000);
}
