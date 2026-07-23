// Chunking SEMÂNTICO (por seções e não por quantidade fixa de caracteres): quebra
// o Markdown otimizado em blocos que preservam título/seção, página de origem e
// tipo de elemento, mantendo TABELAS inteiras (nunca corta uma tabela no meio).
// Cada chunk carrega a rastreabilidade exigida (página, seção, tipo, referência),
// para a IA poder dizer de qual página cada dado veio.
import { estimateTokens } from './tokens.js';

const PAGE_MARK = /^<!--\s*page:\s*(\d+)\s*-->$/i;
const HEADING = /^(#{1,6})\s+(.*)$/;
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);

// Classifica o tipo predominante de um bloco de texto.
function classify(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length && lines.every(l => isTableRow(l) || /^\s*\|?[\s:|-]+\|?\s*$/.test(l))) return 'table';
  if (lines.some(isTableRow)) return 'mixed';
  if (lines.every(l => /^\s*([-*+]|\d+\.)\s+/.test(l))) return 'list';
  return 'text';
}

// Percorre o Markdown mantendo o "cursor" de página e de seção (último heading).
// Emite segmentos por bloco separado por linha em branco, garantindo que uma
// tabela inteira fique num único segmento.
function* segments(md) {
  const lines = String(md || '').split('\n');
  let page = 1;
  let section = null;
  let buf = [];
  let inTable = false;

  const flush = function* () {
    const text = buf.join('\n').trim();
    buf = [];
    if (text) yield { page, section, text };
  };

  for (const raw of lines) {
    const line = raw;
    const pm = line.match(PAGE_MARK);
    if (pm) { yield* flush(); page = Number(pm[1]); continue; }

    const hm = line.match(HEADING);
    if (hm && !inTable) {
      yield* flush();
      section = hm[2].trim();
      yield { page, section, text: line, heading: true };
      continue;
    }

    const rowIsTable = isTableRow(line);
    // Fronteira de bloco: linha em branco fora de tabela.
    if (!line.trim() && !inTable) { yield* flush(); continue; }
    if (rowIsTable) inTable = true;
    else if (inTable && !line.trim()) { inTable = false; yield* flush(); continue; }
    else if (inTable && !rowIsTable) inTable = false;

    buf.push(line);
  }
  yield* flush();
}

// Divide um texto grande demais em pedaços por frases (fallback): mantém o
// chunking semântico como regra, mas garante que NENHUM chunk de texto estoure
// muito o limite (ex.: um parágrafo enorme). Tabelas nunca passam por aqui.
function splitOversizedText(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return [text];
  const sentences = text.split(/(?<=[.!?;:])\s+/);
  const out = [];
  let buf = '';
  for (const s of sentences) {
    const candidate = buf ? `${buf} ${s}` : s;
    if (buf && estimateTokens(candidate) > maxTokens) { out.push(buf); buf = s; }
    else buf = candidate;
  }
  if (buf) out.push(buf);
  // Uma única frase ainda gigante: parte por palavras como último recurso.
  return out.flatMap(part => {
    if (estimateTokens(part) <= maxTokens * 1.2) return [part];
    const words = part.split(/\s+/);
    const pieces = [];
    let b = '';
    for (const w of words) {
      const c = b ? `${b} ${w}` : w;
      if (b && estimateTokens(c) > maxTokens) { pieces.push(b); b = w; }
      else b = c;
    }
    if (b) pieces.push(b);
    return pieces;
  });
}

// Agrupa os segmentos em chunks respeitando o limite de tokens, sem misturar
// seções diferentes e sem dividir tabelas. Um segmento-tabela vira sempre seu
// próprio chunk (para validação de linhas/colunas depois).
export function chunkMarkdown(md, { maxChunkTokens = 1200, documentId = 'doc' } = {}) {
  const chunks = [];
  let cur = null;
  let tableSeq = 0;

  const push = () => {
    if (cur && cur.content.trim()) {
      // Garante o limite de tokens mesmo para um parágrafo isolado muito grande.
      const parts = splitOversizedText(cur.content.trim(), maxChunkTokens);
      parts.forEach((part) => {
        chunks.push({
          ...cur,
          content: part,
          tokens: estimateTokens(part),
          source_reference: `page_${cur.page}_block_${chunks.length + 1}`,
        });
      });
    }
    cur = null;
  };

  for (const seg of segments(md)) {
    if (seg.heading) { push(); continue; } // o heading vira a seção dos próximos

    const type = classify(seg.text);
    const segTokens = estimateTokens(seg.text);

    if (type === 'table') {
      push();
      tableSeq += 1;
      chunks.push({
        document_id: documentId,
        page: seg.page,
        section: seg.section || null,
        element_type: 'table',
        type: 'table',
        tableIndex: tableSeq,
        content: seg.text.trim(),
        tokens: segTokens,
        source_reference: `page_${seg.page}_table_${tableSeq}`,
      });
      continue;
    }

    const sameSection = cur && cur.section === (seg.section || null) && cur.page === seg.page;
    const fits = cur && estimateTokens(cur.content + '\n\n' + seg.text) <= maxChunkTokens;
    if (cur && sameSection && fits) {
      cur.content += '\n\n' + seg.text;
      cur.type = cur.type === type ? type : 'mixed';
      cur.element_type = cur.type;
    } else {
      push();
      cur = {
        document_id: documentId,
        page: seg.page,
        section: seg.section || null,
        element_type: type,
        type,
        content: seg.text.trim(),
      };
    }
  }
  push();
  return chunks;
}
