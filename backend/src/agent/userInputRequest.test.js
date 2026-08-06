// Perguntas interativas (`ask_user`): validação no BACKEND dos argumentos que o
// modelo manda. Nada do que o modelo escreve chega à interface sem passar aqui.
// Roda com: node --test src/agent/userInputRequest.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_USER_TOOL_NAME,
  INPUT_REQUEST_LIMITS,
  askUserToolDefinition,
  normalizeInputRequest,
  shouldOfferAskUser,
  textInputRequest
} from './userInputRequest.js';

test('a definição da ferramenta declara o nome e os três tipos de pergunta', () => {
  assert.equal(askUserToolDefinition.function.name, ASK_USER_TOOL_NAME);
  assert.deepEqual(askUserToolDefinition.function.parameters.properties.kind.enum, ['text', 'confirm', 'select']);
  assert.equal(askUserToolDefinition.function.parameters.additionalProperties, false);
  assert.deepEqual(askUserToolDefinition.function.parameters.required, ['question', 'kind']);
});

test('pergunta de texto válida gera solicitação com id do backend', () => {
  const { request, error } = normalizeInputRequest({ kind: 'text', question: 'Qual formato prefere?', placeholder: 'ex.: XLSX' });
  assert.equal(error, undefined);
  assert.equal(request.kind, 'text');
  assert.equal(request.question, 'Qual formato prefere?');
  assert.equal(request.placeholder, 'ex.: XLSX');
  assert.match(request.id, /^iq_[A-Za-z0-9_-]{10}$/);
  assert.ok(!Number.isNaN(Date.parse(request.createdAt)));
  assert.equal(request.required, false);
});

test('o id escrito pelo MODELO é ignorado (o backend gera o dele)', () => {
  const { request } = normalizeInputRequest({ kind: 'confirm', question: 'Prossigo?', id: 'iq_do_modelo' });
  assert.notEqual(request.id, 'iq_do_modelo');
});

test('propriedades desconhecidas são descartadas', () => {
  const { request } = normalizeInputRequest({ kind: 'text', question: 'Ok?', executar: 'rm -rf /', tools: ['bash'] });
  assert.deepEqual(Object.keys(request).sort(), ['createdAt', 'id', 'kind', 'question', 'required']);
});

test('sem pergunta ou com kind inválido devolve erro para o modelo corrigir', () => {
  assert.match(normalizeInputRequest({ kind: 'text' }).error, /question/);
  assert.match(normalizeInputRequest({ kind: 'text', question: '   ' }).error, /question/);
  assert.match(normalizeInputRequest({ kind: 'radio', question: 'Qual?' }).error, /kind/);
  assert.match(normalizeInputRequest(null).error, /question/);
});

test('HTML na pergunta, nas opções e nos rótulos é recusado', () => {
  assert.match(normalizeInputRequest({ kind: 'text', question: '<img src=x onerror=1> Qual?' }).error, /HTML/i);
  assert.match(normalizeInputRequest({
    kind: 'select',
    question: 'Qual estratégia?',
    options: [{ label: '<b>A</b>', value: 'a' }, { label: 'B', value: 'b' }]
  }).error, /HTML/i);
  assert.match(normalizeInputRequest({ kind: 'confirm', question: 'Ok?', confirmLabel: '<script>x</script>' }).error, /HTML/i);
});

test('select exige pelo menos duas opções e no máximo oito', () => {
  assert.match(normalizeInputRequest({ kind: 'select', question: 'Qual?', options: [{ label: 'A', value: 'a' }] }).error, /duas op/i);
  assert.match(normalizeInputRequest({ kind: 'select', question: 'Qual?' }).error, /duas op/i);
  const nove = Array.from({ length: 9 }, (_, i) => ({ label: `Opção ${i}`, value: `v${i}` }));
  assert.match(normalizeInputRequest({ kind: 'select', question: 'Qual?', options: nove }).error, /8 op/);
});

test('select válido preserva rótulo, valor e descrição', () => {
  const { request } = normalizeInputRequest({
    kind: 'select',
    question: 'Qual estratégia devo aplicar?',
    options: [
      { label: 'Correção mínima', value: 'minimal', description: 'Altera apenas o defeito.' },
      { label: 'Refatoração completa', value: 'refactor' }
    ],
    required: true
  });
  assert.equal(request.options.length, 2);
  assert.deepEqual(request.options[0], { label: 'Correção mínima', value: 'minimal', description: 'Altera apenas o defeito.' });
  assert.deepEqual(request.options[1], { label: 'Refatoração completa', value: 'refactor' });
  assert.equal(request.required, true);
});

test('valores repetidos em select são recusados (resposta ambígua)', () => {
  const dup = normalizeInputRequest({
    kind: 'select',
    question: 'Qual?',
    options: [{ label: 'A', value: 'x' }, { label: 'B', value: 'x' }]
  });
  assert.match(dup.error, /duas vezes/);
});

test('opções em kind text/confirm são descartadas', () => {
  const { request } = normalizeInputRequest({
    kind: 'confirm',
    question: 'Publico?',
    options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    confirmLabel: 'Enviar e abrir PR',
    cancelLabel: 'Manter apenas localmente'
  });
  assert.equal(request.options, undefined);
  assert.equal(request.confirmLabel, 'Enviar e abrir PR');
  assert.equal(request.cancelLabel, 'Manter apenas localmente');
});

test('textos acima do limite são cortados, não recusados', () => {
  const { request } = normalizeInputRequest({ kind: 'text', question: 'a'.repeat(INPUT_REQUEST_LIMITS.question + 500) });
  assert.equal(request.question.length, INPUT_REQUEST_LIMITS.question);
});

test('fallback textual monta uma solicitação de texto marcada como fallback', () => {
  const request = textInputRequest('Prefere XLSX ou CSV?');
  assert.equal(request.kind, 'text');
  assert.equal(request.question, 'Prefere XLSX ou CSV?');
  assert.equal(request.fallback, true);
  // O fallback é o próprio texto já mostrado: markdown e "<" de código passam.
  assert.equal(textInputRequest('Uso `<div>` ou `<section>`?').question, 'Uso `<div>` ou `<section>`?');
  assert.match(textInputRequest('').question, /resposta/i);
});

test('a ferramenta não é oferecida a sub-agente, turno social, segundo plano ou assistente sem ferramentas', () => {
  assert.equal(shouldOfferAskUser({ hasTools: true }), true);
  assert.equal(shouldOfferAskUser({ hasTools: true, isSubagent: true }), false);
  assert.equal(shouldOfferAskUser({ hasTools: true, lowSignalTurn: true }), false);
  assert.equal(shouldOfferAskUser({ hasTools: true, forceExecution: true }), false);
  assert.equal(shouldOfferAskUser({ hasTools: false }), false);
});
