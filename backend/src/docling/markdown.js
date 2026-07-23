// Otimização do Markdown que vai para a IA. O Docling entrega um Markdown fiel;
// aqui removemos o RUÍDO repetitivo (cabeçalhos/rodapés que se repetem em toda
// página, páginas duplicadas, linhas em branco excessivas) SEM descartar
// conteúdo relevante. A meta é reduzir tokens preservando títulos, listas e
// tabelas — nunca "economizar" apagando informação útil (critério de aceite 14).
//
// Convenção: o Docling/nosso runner separa páginas com uma marca de página
// "<!-- page: N -->" no Markdown. As funções abaixo trabalham sobre isso e são
// puras (fáceis de testar).

const PAGE_MARK = /^<!--\s*page:\s*(\d+)\s*-->$/i;

// Divide o Markdown em páginas usando as marcas. Sem marcas, tudo vira 1 página.
export function splitPages(md) {
  const lines = String(md || '').split('\n');
  const pages = [];
  let current = { page: 1, lines: [] };
  let sawMark = false;
  for (const line of lines) {
    const m = line.match(PAGE_MARK);
    if (m) {
      if (sawMark || current.lines.length) pages.push(current);
      current = { page: Number(m[1]), lines: [] };
      sawMark = true;
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length || pages.length === 0) pages.push(current);
  return pages.map(p => ({ page: p.page, text: p.lines.join('\n') }));
}

// Normaliza uma linha para comparação (ignora números de página, espaços, caixa).
function norm(line) {
  return String(line).trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
}

// Descobre linhas que se repetem no TOPO ou no RODAPÉ da maioria das páginas —
// candidatas a cabeçalho/rodapé de página. Retorna um Set de formas normalizadas.
export function detectRunningHeadFoot(pages, { edge = 3, minRatio = 0.6 } = {}) {
  if (pages.length < 3) return new Set();
  const counts = new Map();
  const bump = (line) => {
    const n = norm(line);
    if (!n || n.length < 3) return;
    counts.set(n, (counts.get(n) || 0) + 1);
  };
  for (const p of pages) {
    const ls = p.text.split('\n').filter(l => l.trim());
    ls.slice(0, edge).forEach(bump);
    ls.slice(-edge).forEach(bump);
  }
  const threshold = Math.ceil(pages.length * minRatio);
  const repeated = new Set();
  for (const [n, c] of counts) if (c >= threshold) repeated.add(n);
  return repeated;
}

// Remove páginas cujo conteúdo é idêntico a uma já vista (duplicadas).
function dropDuplicatePages(pages) {
  const seen = new Set();
  const out = [];
  const dupes = [];
  for (const p of pages) {
    const sig = norm(p.text).replace(/\s+/g, '');
    if (sig && seen.has(sig)) { dupes.push(p.page); continue; }
    if (sig) seen.add(sig);
    out.push(p);
  }
  return { pages: out, duplicates: dupes };
}

// Colapsa 3+ linhas em branco em no máximo uma e apara espaços à direita.
function collapseBlank(text) {
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Pipeline de otimização. Retorna o Markdown limpo + um relatório do que foi
// removido (para transparência na interface).
export function optimizeMarkdown(md, { keepPageMarks = true } = {}) {
  const pages = splitPages(md);
  const running = detectRunningHeadFoot(pages);
  const { pages: unique, duplicates } = dropDuplicatePages(pages);

  let removedHeadFoot = 0;
  const cleaned = unique.map(p => {
    const kept = p.text.split('\n').filter(line => {
      if (!line.trim()) return true;
      if (running.has(norm(line))) { removedHeadFoot++; return false; }
      return true;
    }).join('\n');
    return { page: p.page, text: collapseBlank(kept) };
  }).filter(p => p.text);

  const body = cleaned
    .map(p => (keepPageMarks ? `<!-- page: ${p.page} -->\n${p.text}` : p.text))
    .join('\n\n');

  return {
    markdown: collapseBlank(body),
    report: {
      pages: pages.length,
      keptPages: cleaned.length,
      duplicatePages: duplicates,
      removedHeaderFooterLines: removedHeadFoot,
      runningPatterns: running.size,
    },
  };
}
