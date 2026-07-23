import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdownTable, validateTable, tableToCsv, summarizeTables } from './tables.js';

const OK = [
  '| Competência | Valor |',
  '| --- | --- |',
  '| 01/2025 | 100,00 |',
  '| 02/2025 | 200,00 |',
].join('\n');

test('parseMarkdownTable extrai cabeçalho e linhas, ignora o separador', () => {
  const t = parseMarkdownTable(OK);
  assert.deepEqual(t.headers, ['Competência', 'Valor']);
  assert.equal(t.cols, 2);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0], ['01/2025', '100,00']);
});

test('validateTable aprova tabela coerente', () => {
  const v = validateTable(OK);
  assert.equal(v.ok, true);
  assert.equal(v.colCount, 2);
  assert.equal(v.rowCount, 2);
  assert.deepEqual(v.issues, []);
});

test('validateTable detecta colunas inconsistentes', () => {
  const bad = ['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 |'].join('\n');
  const v = validateTable(bad);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some(i => i.startsWith('colunas_inconsistentes')));
});

test('validateTable detecta cabeçalho vazio e ausência de linhas', () => {
  const v = validateTable('| A | |\n| --- | --- |');
  assert.ok(v.issues.includes('cabecalho_vazio'));
  assert.ok(v.issues.includes('sem_linhas'));
});

test('validateTable detecta coluna inteiramente vazia', () => {
  const t = ['| A | B |', '| --- | --- |', '| 1 | |', '| 2 | |'].join('\n');
  const v = validateTable(t);
  assert.ok(v.issues.some(i => i.startsWith('coluna_vazia')));
});

test('tableToCsv gera CSV fiel com escape de vírgulas e aspas', () => {
  const md = ['| Nome | Obs |', '| --- | --- |', '| Empresa, Ltda | disse "oi" |'].join('\n');
  const csv = tableToCsv(md);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Nome,Obs');
  assert.equal(lines[1], '"Empresa, Ltda","disse ""oi"""');
});

test('tableToCsv alinha linhas curtas/longas ao número de colunas', () => {
  const md = ['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 |', '| x | y | z | w |'].join('\n');
  const csv = tableToCsv(md).split('\r\n');
  assert.equal(csv[1], '1,2,'); // preenche a faltante
  assert.equal(csv[2], 'x,y,z'); // apara a excedente
});

test('summarizeTables conta tabelas e alertas', () => {
  const chunks = [
    { type: 'table', tableIndex: 1, page: 7, content: OK },
    { type: 'table', tableIndex: 2, page: 8, content: '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |' },
    { type: 'text', page: 1, content: 'texto' },
  ];
  const s = summarizeTables(chunks);
  assert.equal(s.count, 2);
  assert.equal(s.withWarnings, 1);
  assert.equal(s.details[0].ok, true);
  assert.equal(s.details[1].ok, false);
});
