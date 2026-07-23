import assert from 'node:assert/strict';
import test from 'node:test';
import { hashBuffer } from './hash.js';
import { estimateTokens, savings } from './tokens.js';
import { optimizeMarkdown, splitPages, detectRunningHeadFoot } from './markdown.js';
import { chunkMarkdown } from './chunker.js';
import { configVersion, isDoclingSupported, doclingOptions } from './config.js';
import { selectChunks } from './context.js';

// ---- hash ----
test('hashBuffer é estável e sensível ao conteúdo', () => {
  const a = hashBuffer(Buffer.from('balanço patrimonial'));
  const b = hashBuffer(Buffer.from('balanço patrimonial'));
  const c = hashBuffer(Buffer.from('balanço patrimonia1'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

// ---- tokens ----
test('estimateTokens cresce com o tamanho e savings calcula o percentual', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(400)) >= 100);
  const s = savings(1000, 250);
  assert.equal(s.savedTokens, 750);
  assert.equal(s.percent, 75);
  assert.equal(savings(0, 0).percent, 0);
});

// ---- markdown: páginas ----
test('splitPages separa por marcas de página', () => {
  const md = '<!-- page: 1 -->\nOlá\n<!-- page: 2 -->\nMundo';
  const pages = splitPages(md);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].page, 1);
  assert.equal(pages[1].page, 2);
  assert.match(pages[1].text, /Mundo/);
});

test('detectRunningHeadFoot acha cabeçalho repetido em toda página', () => {
  const pages = [1, 2, 3, 4].map(n => ({ page: n, text: `Empresa XYZ Ltda\nConteúdo da página ${n}\nPágina ${n} de 4` }));
  const running = detectRunningHeadFoot(pages);
  // "empresa xyz ltda" e "página # de #" devem ser detectados como repetição.
  assert.ok(running.has('empresa xyz ltda'));
});

test('optimizeMarkdown remove cabeçalho/rodapé repetido e página duplicada', () => {
  const page = (n, body) => `<!-- page: ${n} -->\nEmpresa XYZ Ltda\n${body}\nPágina ${n}`;
  const md = [page(1, 'Receita 1000'), page(2, 'Despesa 200'), page(3, 'Despesa 200'), page(4, 'Lucro 800')].join('\n');
  const { markdown, report } = optimizeMarkdown(md);
  assert.ok(report.removedHeaderFooterLines > 0, 'deve remover linhas de cabeçalho/rodapé');
  assert.ok(report.duplicatePages.includes(3), 'página 3 é duplicata da 2');
  assert.ok(!markdown.includes('Empresa XYZ Ltda'), 'cabeçalho repetido some');
  assert.ok(markdown.includes('Receita 1000') && markdown.includes('Lucro 800'), 'conteúdo relevante permanece');
});

test('optimizeMarkdown preserva conteúdo quando não há repetição', () => {
  const md = '<!-- page: 1 -->\n# Título\nTexto único aqui.';
  const { markdown } = optimizeMarkdown(md);
  assert.match(markdown, /# Título/);
  assert.match(markdown, /Texto único aqui/);
});

// ---- chunker ----
test('chunkMarkdown mantém tabela inteira como um chunk do tipo table com página', () => {
  const md = [
    '<!-- page: 7 -->',
    '## Débitos Previdenciários',
    'Texto introdutório da seção.',
    '',
    '| Competência | Valor |',
    '| --- | --- |',
    '| 01/2025 | 100,00 |',
    '| 02/2025 | 200,00 |',
  ].join('\n');
  const chunks = chunkMarkdown(md, { documentId: 'arquivo_123' });
  const table = chunks.find(c => c.type === 'table');
  assert.ok(table, 'deve existir um chunk de tabela');
  assert.equal(table.page, 7);
  assert.equal(table.section, 'Débitos Previdenciários');
  assert.match(table.content, /Competência/);
  assert.match(table.content, /02\/2025/);
  assert.match(table.source_reference, /page_7_table_1/);
  // O texto da seção vira um chunk separado, também na página 7.
  const text = chunks.find(c => c.type !== 'table');
  assert.equal(text.page, 7);
  assert.equal(text.section, 'Débitos Previdenciários');
});

test('chunkMarkdown respeita o limite de tokens por chunk', () => {
  const para = 'palavra '.repeat(120); // ~ além do limite pequeno
  const md = ['<!-- page: 1 -->', '## Seção', para, '', para, '', para].join('\n');
  const chunks = chunkMarkdown(md, { maxChunkTokens: 60 });
  assert.ok(chunks.length >= 2, 'deve dividir em múltiplos chunks');
  for (const c of chunks) assert.ok(c.tokens <= 200, 'nenhum chunk absurdamente grande');
});

// ---- config ----
test('configVersion muda quando uma opção relevante muda (invalida cache)', () => {
  const base = doclingOptions();
  const v1 = configVersion({ ...base, ocr: 'auto', lang: 'por' });
  const v2 = configVersion({ ...base, ocr: 'always', lang: 'por' });
  const v3 = configVersion({ ...base, ocr: 'auto', lang: 'eng' });
  assert.notEqual(v1, v2);
  assert.notEqual(v1, v3);
  assert.equal(v1, configVersion({ ...base, ocr: 'auto', lang: 'por' }));
});

// ---- seleção de chunks (context) ----
test('selectChunks prioriza os chunks relevantes à pergunta dentro do orçamento', () => {
  const chunks = [
    { page: 1, section: 'Receitas', type: 'text', content: 'Receita bruta do período foi de mil reais.', tokens: 20 },
    { page: 2, section: 'Débitos Previdenciários', type: 'table', content: '| INSS | 500 |', tokens: 20, source_reference: 'page_2_table_1' },
    { page: 3, section: 'Notas', type: 'text', content: 'Texto irrelevante sobre outro assunto qualquer.', tokens: 20 },
  ];
  const picked = selectChunks(chunks, 'qual o valor do INSS previdenciário?', 40);
  assert.ok(picked.some(c => c.type === 'table'), 'a tabela de INSS deve ser selecionada');
  assert.ok(picked.every(c => c.tokens <= 40));
});

test('selectChunks sem pergunta mantém a ordem do documento', () => {
  const chunks = [
    { page: 2, type: 'text', content: 'B', tokens: 10 },
    { page: 1, type: 'text', content: 'A', tokens: 10 },
  ];
  const picked = selectChunks(chunks, '', 100);
  assert.equal(picked[0].page, 1); // reordenado por página
});

test('isDoclingSupported reconhece PDF e afins, rejeita desconhecidos', () => {
  assert.ok(isDoclingSupported('balanco.pdf'));
  assert.ok(isDoclingSupported('relatorio.DOCX'));
  assert.ok(isDoclingSupported('scan.png'));
  assert.ok(!isDoclingSupported('video.mp4'));
  assert.ok(!isDoclingSupported('arquivo.zip'));
});
