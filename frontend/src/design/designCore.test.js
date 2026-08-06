import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESIGN_OUTPUT_TYPES, outputTypeMeta, exportFormatsFor, formatWhen,
  versionLabel, canSubmit, exportUrl, modelLabel,
  PREVIEW_MESSAGES, isPreviewMessage, targetLabel, tokenValue, liveOverrideCss, effectiveModel,
  MAX_IMAGE_PROMPT_CHARS, buildImageApplyPrompt,
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

// ---- Ponte com a prévia (v2) -----------------------------------------------

test('os tipos de mensagem batem com os do backend', () => {
  // O outro lado é backend/src/design/bridge.js. Divergir não dá erro: a
  // seleção simplesmente para de funcionar, em silêncio.
  assert.deepEqual(Object.keys(PREVIEW_MESSAGES).sort(), ['ajustes', 'limparSelecao', 'modo', 'pronto', 'selecionado']);
  for (const valor of Object.values(PREVIEW_MESSAGES)) assert.match(valor, /^fred-preview-/);
});

test('só aceita mensagem da JANELA do iframe — origem não serve de prova', () => {
  // A prévia roda em origem opaca: `event.origin` chega como "null" e comparar
  // isso não prova nada. O que prova é ter vindo do contentWindow do nosso frame.
  const janela = {};
  const frame = { contentWindow: janela };
  const boa = { source: janela, origin: 'null', data: { tipo: PREVIEW_MESSAGES.selecionado } };
  assert.equal(isPreviewMessage(boa, frame), true);
  // Mesma forma, outra janela (outro iframe, um popup, uma extensão): recusada.
  assert.equal(isPreviewMessage({ ...boa, source: {} }, frame), false);
  assert.equal(isPreviewMessage(boa, null), false);
  // Tipo fora do contrato não passa nem vindo da janela certa.
  assert.equal(isPreviewMessage({ source: janela, data: { tipo: 'qualquer-coisa' } }, frame), false);
  assert.equal(isPreviewMessage({ source: janela, data: {} }, frame), false);
});

test('a etiqueta do alvo resume o elemento sem despejar o HTML', () => {
  assert.equal(targetLabel({ tag: 'h1', texto: 'Bem-vindo' }), '<h1> Bem-vindo');
  assert.equal(targetLabel({ tag: 'div', texto: '' }), '<div>');
  assert.equal(targetLabel({ slide: 3, tag: 'h2', texto: 'Escopo' }), 'Slide 3');
  assert.match(targetLabel({ tag: 'p', texto: 'x'.repeat(90) }), /…$/);
  assert.equal(targetLabel(null), '');
});

test('o controle abre no valor do design quando não há ajuste', () => {
  const token = { id: 'raio', kind: 'medida', unit: 'px', defaultValue: 12 };
  assert.equal(tokenValue(token, {}), 12);
  assert.equal(tokenValue(token, { raio: 0 }), 0, 'zero é ajuste, não ausência');
  assert.equal(tokenValue(token, { raio: null }), 12, 'nulo volta ao valor do design');
  assert.equal(tokenValue(token, null), 12);
});

test('o CSS ao vivo cobre só os tokens do design, com unidade', () => {
  const tokens = [
    { id: 'corPrimaria', cssVar: '--fred-cor-primaria', kind: 'cor', defaultValue: '#1f3b8a' },
    { id: 'raio', cssVar: '--fred-raio', kind: 'medida', unit: 'px', defaultValue: 12 },
  ];
  const css = liveOverrideCss(tokens, { corPrimaria: '#0a7d55' });
  assert.match(css, /--fred-cor-primaria: #0a7d55 !important;/);
  // O token não tocado também entra, com o valor do próprio design: o bloco é
  // uma foto completa do estado, e não um diff — assim uma restauração parcial
  // não deixa metade do CSS antigo valendo.
  assert.match(css, /--fred-raio: 12px !important;/);
  assert.equal(liveOverrideCss([], {}), '');
  assert.equal(liveOverrideCss(null, {}), '');
});

test('o modelo do projeto vence o do app (espelho de modelForProject)', () => {
  // As duas pontas precisam concordar: se a tela mostrar um modelo e o backend
  // usar outro, o usuário troca o seletor e o resultado sai pelo modelo antigo.
  assert.equal(effectiveModel({ modelRef: 'prov::fixo' }, 'prov::do-chat'), 'prov::fixo');
  assert.equal(effectiveModel({ modelRef: null }, 'prov::do-chat'), 'prov::do-chat');
  assert.equal(effectiveModel(null, 'prov::do-chat'), 'prov::do-chat');
  assert.equal(effectiveModel({ modelRef: null }, ''), '');
});

test('MAX_IMAGE_PROMPT_CHARS espelha o teto do backend (1000)', () => {
  assert.equal(MAX_IMAGE_PROMPT_CHARS, 1000);
});

test('buildImageApplyPrompt monta o pedido de inserir a imagem com o src completo', () => {
  const image = { src: 'https://api/.../images/abc?token=xyz', prompt: 'um pôr do sol' };
  const pedido = buildImageApplyPrompt(image);
  assert.match(pedido, /Inclua esta imagem/);
  assert.match(pedido, /<img src="https:\/\/api\/...\/images\/abc\?token=xyz"/);
  assert.match(pedido, /alt="um pôr do sol"/);
  assert.match(pedido, /mantenha o restante do design idêntico/);
});

test('buildImageApplyPrompt escapa aspas no alt para não quebrar o atributo', () => {
  const image = { src: 'https://x/y', prompt: 'uma "cena"' };
  const pedido = buildImageApplyPrompt(image);
  assert.match(pedido, /alt="uma &quot;cena&quot;"/);
  assert.ok(!pedido.includes('alt="uma "cena""'), 'aspas no alt abririam o atributo');
});

test('buildImageApplyPrompt devolve string vazia se a imagem não tem src', () => {
  assert.equal(buildImageApplyPrompt(null), '');
  assert.equal(buildImageApplyPrompt({ src: '' }), '');
});
