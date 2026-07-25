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

// Normaliza uma linha para comparação: só espaços e caixa. Os NÚMEROS ficam,
// porque em documento contábil/fiscal o número É o conteúdo — mascará-los aqui
// fazia "Valor apurado: 1.000,00" e "Valor apurado: 2.500,00" parecerem a MESMA
// linha e o otimizador apagava os dados de todas as páginas.
function norm(line) {
  return String(line).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Linhas de PAGINAÇÃO ("Página 1 de 3", "- 12 -") mudam de página para página só
// no número. Para elas — e só para elas — vale comparar com os dígitos
// mascarados, senão nunca seriam reconhecidas como rodapé.
const PAGINATION_RE = /\b(p[áa]g(?:ina)?|page|folha|fl\.?)\b|^\s*[-—|\s]*\d+[-—|\s]*$/i;
function normPagination(line) {
  return norm(line).replace(/\d+/g, '#');
}
function comparableForms(line) {
  const base = norm(line);
  return PAGINATION_RE.test(base) ? [base, normPagination(line)] : [base];
}

// Descobre linhas que se repetem no TOPO ou no RODAPÉ da maioria das páginas —
// candidatas a cabeçalho/rodapé de página. Retorna um Set de formas comparáveis.
export function detectRunningHeadFoot(pages, { edge = 3, minRatio = 0.6 } = {}) {
  if (pages.length < 3) return new Set();
  const counts = new Map();
  for (const p of pages) {
    const ls = p.text.split('\n').filter(l => l.trim());
    // ÍNDICES (não linhas) das bordas: numa página curta o começo e o fim se
    // sobrepõem, e contar a mesma linha física duas vezes fazia um título único
    // atingir sozinho o limiar e ser apagado como se fosse cabeçalho.
    const edges = new Set([
      ...ls.keys()].filter(i => i < edge || i >= ls.length - edge));
    // Uma forma conta no MÁXIMO uma vez por página (evita que uma linha repetida
    // dentro da mesma página vire "cabeçalho de todas as páginas").
    const seenInPage = new Set();
    for (const i of edges) {
      for (const form of comparableForms(ls[i])) {
        if (!form || form.length < 3 || seenInPage.has(form)) continue;
        seenInPage.add(form);
        counts.set(form, (counts.get(form) || 0) + 1);
      }
    }
  }
  const threshold = Math.ceil(pages.length * minRatio);
  const repeated = new Set();
  for (const [n, c] of counts) if (c >= threshold) repeated.add(n);
  return repeated;
}

// Assinatura de uma página para comparar duplicatas. Feita LINHA A LINHA: só as
// linhas de paginação têm os dígitos mascarados, para que "Página 2"/"Página 3"
// não impeçam de ver que o resto é idêntico. Mascarar a página inteira (o que
// era feito antes) tratava como duplicadas páginas que diferiam justamente nos
// VALORES — num relatório fiscal de 120 páginas, 119 eram descartadas.
function pageSignature(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => { const forms = comparableForms(l); return forms[forms.length - 1]; })
    .join('|')
    .replace(/\s+/g, '');
}

// Remove páginas cujo conteúdo é idêntico a uma já vista (duplicadas).
function dropDuplicatePages(pages) {
  const seen = new Set();
  const out = [];
  const dupes = [];
  for (const p of pages) {
    const sig = pageSignature(p.text);
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
    const lines = p.text.split('\n');
    let removedHere = 0;
    const kept = lines.filter(line => {
      if (!line.trim()) return true;
      if (comparableForms(line).some(form => running.has(form))) { removedHere++; return false; }
      return true;
    });
    // REDE DE SEGURANÇA: se a limpeza esvaziaria uma página que tinha conteúdo,
    // a detecção errou — devolve a página inteira. Otimizar nunca pode custar
    // informação (o objetivo é cortar ruído, não apagar o documento).
    const text = collapseBlank(kept.join('\n'));
    if (!text && p.text.trim()) return { page: p.page, text: collapseBlank(p.text) };
    removedHeadFoot += removedHere;
    return { page: p.page, text };
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
