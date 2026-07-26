import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESIGN_OUTPUT_TYPES, outputTypeMeta, exportFormatsFor, formatWhen,
  versionLabel, canSubmit, exportUrl, modelLabel,
} from './designCore.js';

// A lista de formatos aqui espelha EXPORT_FORMATS do backend
// (backend/src/design/core.js). Se as duas divergirem, o botão aparece na tela
// e a rota recusa o formato — erro que só aparece no clique. Este arquivo é o
// lugar onde essa duplicação fica visível.

test('todo tipo de saída tem rótulo, descrição e exemplo de pedido', () => {
  assert.equal(DESIGN_OUTPUT_TYPES.length, 3);
  for (const type of DESIGN_OUTPUT_TYPES) {
    assert.ok(type.label && type.short && type.desc && type.placeholder, `faltou campo em ${type.id}`);
  }
});

test('tipo desconhecido cai no primeiro em vez de quebrar a tela', () => {
  assert.equal(outputTypeMeta('video').id, 'web');
  assert.equal(outputTypeMeta('slides').id, 'slides');
});

test('formatos de exportação por tipo (espelho do backend)', () => {
  assert.deepEqual(exportFormatsFor('web').map(f => f.id), ['html']);
  assert.deepEqual(exportFormatsFor('slides').map(f => f.id), ['html', 'pdf', 'pptx']);
  assert.deepEqual(exportFormatsFor('document').map(f => f.id), ['html', 'pdf']);
  // Tipo desconhecido não pode oferecer .pptx de uma página web.
  assert.deepEqual(exportFormatsFor('planilha').map(f => f.id), ['html']);
});

test('a URL de exportação escapa o id e leva a versão quando pedida', () => {
  const url = exportUrl('', 'abc/def', 'pdf');
  assert.match(url, /\/api\/design\/projects\/abc%2Fdef\/export\?format=pdf$/);
  assert.match(exportUrl('', 'p1', 'html', 'v9'), /versionId=v9/);
});

test('a data mostra a hora — o histórico costuma ter várias versões no mesmo dia', () => {
  const ref = new Date('2026-07-26T18:00:00');
  assert.match(formatWhen('2026-07-26T14:32:00', ref), /^hoje \d{2}:\d{2}$/);
  assert.match(formatWhen('2026-03-12T09:10:00', ref), /^12\/03 \d{2}:\d{2}$/);
  assert.equal(formatWhen(''), '');
  assert.equal(formatWhen('não é data'), '');
});

test('a versão em exibição é marcada — e não é sempre a mais recente', () => {
  // Depois de reverter, a versão atual é uma antiga: o rótulo tem de seguir o
  // ponteiro do projeto, não a ordem da lista.
  assert.equal(versionLabel({ id: 'v2', versionNumber: 2 }, 'v2'), 'v2 · atual');
  assert.equal(versionLabel({ id: 'v7', versionNumber: 7 }, 'v2'), 'v7');
});

test('não envia pedido vazio nem durante uma geração', () => {
  assert.equal(canSubmit('mude a cor', false), true);
  assert.equal(canSubmit('   ', false), false);
  assert.equal(canSubmit('mude a cor', true), false);
  assert.equal(canSubmit(undefined, false), false);
});

test('o rótulo do modelo esconde o id do provedor', () => {
  // A referência interna é "<provedor>::<modelo>"; o prefixo é um id aleatório
  // de banco e não tem o que fazer na tela.
  assert.equal(modelLabel('TIho0m5t1Vui9Dv8YISzU::deepseek-chat'), 'deepseek-chat');
  assert.equal(modelLabel('gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(modelLabel(''), '');
  assert.equal(modelLabel(null), '');
});
