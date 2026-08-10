// Tabelas — parsing, VALIDAÇÃO de coerência e exportação para CSV. O Docling
// entrega a tabela como Markdown (linhas/colunas/cabeçalho preservados); aqui
// garantimos que ela não vire "texto desorganizado": conferimos se o número de
// colunas é consistente, se há cabeçalho e linhas, e produzimos um CSV fiel.
// Lógica PURA (fácil de testar) — nada de I/O.

// Faz o parse de UMA tabela em Markdown para { headers, rows, cols }.
// Aceita a linha separadora (|---|---|) opcional e ignora pipes das bordas.
export function parseMarkdownTable(md) {
  const lines = String(md || '').split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  const cells = (line) => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    // Não quebra em \| (pipe escapado dentro de célula).
    return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
  };
  const isSep = (line) => /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-');

  const rowsRaw = [];
  let headers = null;
  for (const line of lines) {
    if (isSep(line)) continue; // separador markdown
    const c = cells(line);
    if (!headers) headers = c;
    else rowsRaw.push(c);
  }
  headers = headers || [];
  return { headers, rows: rowsRaw, cols: headers.length };
}

// Valida a coerência da tabela extraída. Retorna { ok, issues, rowCount,
// colCount }. Não é destrutivo — apenas sinaliza (o conteúdo segue disponível).
export function validateTable(table) {
  const t = table && table.headers ? table : parseMarkdownTable(table);
  const issues = [];
  const colCount = t.headers.length;
  const rowCount = t.rows.length;

  if (colCount === 0) issues.push('sem_cabecalho');
  if (t.headers.some(h => h === '')) issues.push('cabecalho_vazio');
  if (rowCount === 0) issues.push('sem_linhas');

  // Linhas com número de colunas diferente do cabeçalho (dados desalinhados).
  const mismatched = t.rows.filter(r => r.length !== colCount).length;
  if (colCount > 0 && mismatched > 0) {
    issues.push(`colunas_inconsistentes:${mismatched}/${rowCount}`);
  }
  // Coluna inteiramente vazia (indício de extração ruim).
  if (colCount > 0 && rowCount > 0) {
    for (let i = 0; i < colCount; i++) {
      if (t.rows.every(r => (r[i] ?? '') === '')) { issues.push(`coluna_vazia:${i}`); break; }
    }
  }

  return { ok: issues.length === 0, issues, rowCount, colCount };
}

// Escapa um campo para CSV (aspas quando houver vírgula, aspas ou quebra).
function csvField(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Converte a tabela (Markdown ou objeto já parseado) em CSV. Preenche/apara
// linhas para o número de colunas do cabeçalho, mantendo os dados alinhados.
export function tableToCsv(table) {
  const t = table && table.headers ? table : parseMarkdownTable(table);
  const cols = t.headers.length;
  const norm = (r) => {
    const row = r.slice(0, cols);
    while (row.length < cols) row.push('');
    return row;
  };
  const lines = [t.headers, ...t.rows.map(norm)].map(r => r.map(csvField).join(','));
  return lines.join('\r\n');
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;

// Extrai os BLOCOS de tabela de um texto qualquer: sequências contíguas de
// linhas que começam e terminam com pipe. Um chunk do tipo `table` devolve um
// bloco só; um chunk `mixed` (prosa + tabela na mesma seção) devolve a tabela
// que estava escondida ali dentro.
export function extractTableBlocks(content) {
  const blocos = [];
  let atual = [];
  for (const linha of String(content || '').split('\n')) {
    if (TABLE_ROW.test(linha)) {
      atual.push(linha);
    } else if (atual.length) {
      blocos.push(atual.join('\n'));
      atual = [];
    }
  }
  if (atual.length) blocos.push(atual.join('\n'));
  // Uma linha isolada de pipes não é tabela — é ruído de OCR ou uma régua.
  return blocos.filter(b => b.split('\n').length >= 2);
}

// Localiza TODAS as tabelas de um conjunto de chunks, na ordem do documento.
//
// Percorre todos os chunks, não só os de `type === 'table'`. O motivo é um
// defeito real: quando a seção tem uma frase antes da tabela — a forma mais
// comum num documento contábil ("Valores expressos em reais." e então a DRE) —
// o chunker classifica o bloco como `mixed`, e a tabela ficava INVISÍVEL. Uma
// DRE com colunas inconsistentes saía como `count: 0, withWarnings: 0`, que se
// lê como "nenhuma tabela com problema" e na verdade era "não procurei". Além
// da métrica mentir, a tabela não aparecia na listagem nem podia ser baixada
// em CSV.
export function findTables(chunks) {
  const achadas = [];
  for (const c of (Array.isArray(chunks) ? chunks : [])) {
    for (const bloco of extractTableBlocks(c.content)) {
      achadas.push({ chunk: c, content: bloco, embedded: c.type !== 'table' });
    }
  }
  // Numeração sequencial na ordem do documento. O identificador ESTÁVEL é o
  // `source_reference`; o índice existe para a rota de CSV, que é servida
  // junto da listagem — por isso as duas usam esta mesma função e não podem
  // divergir, como divergiam quando cada uma filtrava por conta própria.
  return achadas.map((t, i) => ({ ...t, index: i + 1 }));
}

// Resumo de todas as tabelas de um conjunto de chunks (para métricas/alertas).
export function summarizeTables(chunks) {
  const tables = findTables(chunks);
  const details = tables.map((t) => {
    const v = validateTable(parseMarkdownTable(t.content));
    return {
      index: t.index,
      page: t.chunk.page,
      section: t.chunk.section || null,
      source_reference: t.chunk.source_reference,
      embedded: t.embedded,
      rows: v.rowCount, cols: v.colCount,
      ok: v.ok, issues: v.issues,
    };
  });
  return {
    count: tables.length,
    withWarnings: details.filter(d => !d.ok).length,
    details,
  };
}
