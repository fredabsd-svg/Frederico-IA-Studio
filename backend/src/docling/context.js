// Monta o CONTEXTO documental que vai para a IA a partir dos artefatos já
// processados — Markdown otimizado ou os chunks relevantes, sempre com a
// referência de página. É o que substitui, quando o Docling está ligado e o
// documento foi processado, a instrução antiga de "o modelo se vira e extrai".
// Todos os modelos (inclusive no multi-modelo) recebem EXATAMENTE este mesmo
// conteúdo — nada de re-extrair por modelo.
import { db } from '../db.js';
import { isDoclingEnabled } from './config.js';
import { readArtifacts } from './service.js';
import { estimateTokens } from './tokens.js';
import { validateTable } from './tables.js';
import { rankBySimilarity } from './semantic.js';
import { embedOne, cosine, embeddingsDegraded } from '../memory/embeddings.js';

const STOP = new Set('a o e de da do das dos que com para por um uma no na em os as se ao à é qual quais onde quando como sobre entre'.split(' '));
function terms(q) {
  return String(q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
}

// Seleção de chunks por relevância (pura/testável). Pontua por sobreposição de
// termos da pergunta; tabelas ganham um leve bônus (dados costumam estar nelas);
// preenche até o orçamento de tokens. Sem pergunta, mantém a ordem do documento.
export function selectChunks(chunks, query, tokenBudget) {
  const list = Array.isArray(chunks) ? chunks : [];
  const qs = terms(query);
  const scored = list.map((c, i) => {
    const hay = `${c.section || ''} ${c.content || ''}`.toLowerCase();
    let score = 0;
    for (const t of qs) if (hay.includes(t)) score += 1;
    if (c.type === 'table' && score > 0) score += 0.5;
    return { c, i, score };
  });
  const ordered = qs.length
    ? scored.slice().sort((a, b) => b.score - a.score || a.i - b.i)
    : scored;
  const picked = [];
  let used = 0;
  for (const s of ordered) {
    if (qs.length && s.score === 0 && picked.length) continue; // sem match: só se sobrar espaço no fim
    const t = s.c.tokens || estimateTokens(s.c.content);
    if (used + t > tokenBudget && picked.length) continue;
    picked.push(s.c); used += t;
    if (used >= tokenBudget) break;
  }
  // Reordena pela posição original no documento (leitura natural).
  return picked.sort((a, b) => (a.page - b.page) || 0);
}

function renderDoc(filename, markdown, chunks, { query, budget, queryVec, vectors }) {
  const full = estimateTokens(markdown);
  if (full <= budget) {
    return { text: markdown, refs: 'documento completo', tokens: full, mode: 'completo' };
  }
  // Seleção semântica quando há vetores do documento e da pergunta; senão, cai
  // na seleção por palavras (determinística e sempre disponível).
  const semantic = queryVec && Array.isArray(vectors) && vectors.some(Boolean);
  const picked = semantic
    ? rankBySimilarity(chunks, vectors, queryVec, budget, cosine)
    : selectChunks(chunks, query, budget);
  const body = picked.map(c => {
    const head = `> [pág. ${c.page}${c.section ? ` · ${c.section}` : ''}${c.type === 'table' ? ' · tabela' : ''}] (${c.source_reference})`;
    let caution = '';
    if (c.type === 'table') {
      const v = validateTable(c.content);
      if (!v.ok) caution = `\n> ⚠ Estrutura da tabela pode estar inconsistente (${v.issues.join(', ')}). Confira na página ${c.page} antes de afirmar valores.`;
    }
    return `${head}${caution}\n${c.content}`;
  }).join('\n\n');
  const pages = [...new Set(picked.map(c => c.page))].sort((a, b) => a - b);
  return { text: body, refs: `trechos das páginas ${pages.join(', ')}`, tokens: estimateTokens(body), mode: semantic ? 'semantico' : 'palavras' };
}

// Constrói a nota de contexto para a conversa. Retorna null quando não há nada
// processado (ou o Docling está desligado) — nesse caso o app usa o fluxo atual.
export async function buildDocumentContext(userId, conversationId, { query = '', tokenBudget = 6000 } = {}) {
  if (!isDoclingEnabled()) return null;
  const rows = await db.prepare(
    `SELECT * FROM document_processings WHERE user_id=? AND conversation_id=? AND status IN ('done','done_warnings','partial') ORDER BY created_at ASC`
  ).all(userId, conversationId);
  if (!rows.length) return null;

  // Vetor da pergunta (uma vez, reusado por todos os documentos). Se os
  // embeddings estiverem indisponíveis, fica null e a seleção usa palavras.
  let queryVec = null;
  if (query && !embeddingsDegraded()) {
    try { queryVec = await embedOne(query, 'query'); } catch { queryVec = null; }
  }

  const perDoc = Math.max(1500, Math.floor(tokenBudget / rows.length));
  const parts = [];
  const used = [];
  for (const row of rows) {
    const arts = readArtifacts(userId, row.hash, row.config_version);
    if (!arts.markdown) continue;
    const rendered = renderDoc(row.filename || 'documento', arts.markdown, arts.chunks, { query, budget: perDoc, queryVec, vectors: arts.embeddings });
    parts.push(`### ${row.filename || 'documento'} (${row.page_count ?? '?'} pág.${row.ocr_used ? ', via OCR' : ''})\n${rendered.text}`);
    used.push({ hash: row.hash, filename: row.filename, refs: rendered.refs, configVersion: row.config_version });
  }
  if (!parts.length) return null;

  const note = [
    'CONTEÚDO DOS DOCUMENTOS (pré-processado pelo Docling — layout, tabelas e ordem de leitura já resolvidos).',
    'Use este conteúdo como fonte. Cada trecho indica a página de origem entre colchetes — ao responder, cite a página de onde veio cada dado.',
    'Não tente reextrair o arquivo com ferramentas: o conteúdo abaixo já é a extração oficial.',
    '',
    parts.join('\n\n'),
  ].join('\n');

  return { note, used, tokens: estimateTokens(note) };
}
