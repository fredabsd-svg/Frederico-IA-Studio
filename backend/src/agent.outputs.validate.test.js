// F-23 (parcial): cobre a função pura `pickValidatableFiles`, que decide
// quais outputs vão para a validação no sandbox — filtro de extensão,
// case-insensitive e limites.
//
// O QUE ESTE ARQUIVO **NÃO** COBRE, apesar do que dizia aqui antes: os
// validadores `check_xlsx`/`check_docx`. Eles são Python embutido em
// `agent/outputs.js` e rodam no sandbox; os `sandbox/*_test.py` testam os
// kits de GERAÇÃO (docpro/xlspro/pdfpro), que são outros módulos. Ninguém
// os exercita com arquivo real — é o que mantém o F-23 aberto
// (`docs/AUDITORIA_2026-07.md` §2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickValidatableFiles } from './agent/outputs.js';

test('sem arquivos: devolve []', () => {
  assert.deepEqual(pickValidatableFiles([]), []);
  assert.deepEqual(pickValidatableFiles(null), []);
  assert.deepEqual(pickValidatableFiles(undefined), []);
});

test('filtra por extensão (case-insensitive)', () => {
  const files = [
    { name: 'planilha.xlsx' },
    { name: 'documento.DOCX' },
    { name: 'relatorio.PDF' },
    { name: 'codigo.py' },       // não validável
    { name: 'planilha.xlsm' },
    { name: 'log.txt' }            // não validável
  ];
  const got = pickValidatableFiles(files);
  assert.equal(got.length, 4);
  assert.deepEqual(got.map(f => f.name), ['planilha.xlsx', 'documento.DOCX', 'relatorio.PDF', 'planilha.xlsm']);
});

test('limit padrão: 5 arquivos', () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ name: `arq${i}.xlsx` }));
  assert.equal(pickValidatableFiles(files).length, 5);
});

test('limit customizado via segundo parâmetro', () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ name: `arq${i}.xlsx` }));
  assert.equal(pickValidatableFiles(files, 3).length, 3);
  assert.equal(pickValidatableFiles(files, 0).length, 0);
});

test('limit undefined cai no default (5)', () => {
  // O parâmetro `limit` tem default `5` na assinatura — `undefined` é
  // absorvido pelo default. É o comportamento desejado: um chamador que
  // esquece o segundo argumento não recebe TODOS os arquivos.
  const files = Array.from({ length: 10 }, (_, i) => ({ name: `arq${i}.xlsx` }));
  assert.equal(pickValidatableFiles(files, undefined).length, 5);
});

test('arquivo sem `name` é ignorado (não há como decidir)', () => {
  // listOutputs devolve objetos com `name` sempre, mas protege contra
  // entradas parciais (ex.: usuário com permissões parciais).
  const files = [
    { name: 'ok.xlsx' },
    { name: '' },                       // string vazia
    {},                                  // sem name
    { name: null },
    { name: 123 }                        // tipo errado
  ];
  const got = pickValidatableFiles(files);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'ok.xlsx');
});

test('extensão composta não casa (.xlsx.bak, .tar.gz)', () => {
  // A regex é ancorada no fim do nome — `xlsx.bak` não termina em `xlsx`.
  // Evita validar arquivos que têm `.xlsx` no meio do nome mas não são
  // realmente planilhas.
  const files = [
    { name: 'backup.xlsx.bak' },
    { name: 'snapshot.tar.gz' },
    { name: 'report.xls' }              // xls (legado) — não validável
  ];
  assert.equal(pickValidatableFiles(files).length, 0);
});

test('path-like no nome: a regex casa pela extensão final', () => {
  // A regex `\.(xlsx|xlsm|pdf|docx)$` é ancorada no fim do nome. Como o
  // `name` em listOutputs é o basename do arquivo (extraído em path.basename),
  // o caminho completo não aparece. Mas se um chamador hipotético passar
  // um path-like "sub/aninhado.xlsx", a regex casa pelo final. Isso
  // é o comportamento correto: o filtro de extensão é puramente léxico.
  const files = [
    { name: 'planilha.xlsx' },
    { name: 'relatorio.pdf' },
    { name: 'sub/aninhado.xlsx' }
  ];
  const got = pickValidatableFiles(files);
  assert.equal(got.length, 3, `todos os 3 têm extensão válida no fim do nome; recebi: ${JSON.stringify(got)}`);
});

test('arquivos com nome vazio ou só espaços: ignorados', () => {
  const files = [
    { name: '' },
    { name: '   ' },
    { name: '.xlsx' },                  // só extensão, sem nome real
    { name: 'real.xlsx' }
  ];
  // '.xlsx' é um nome degenerado mas a regex `VALIDATABLE.test` aceita
  // (casa em qualquer string que termina com .xlsx). Esse é o
  // comportamento atual — a chamada do validador cuida do filtro
  // semântico depois. Aqui só documentamos.
  assert.equal(pickValidatableFiles(files).length, 2);
});
