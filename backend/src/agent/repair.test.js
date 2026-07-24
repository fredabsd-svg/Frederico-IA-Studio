import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRepairExecution, answerLooksConclusive } from './repair.js';

const CONCLUSIVE = 'A'.repeat(700); // corpo substancial, sem linguagem de adiamento

test('answerLooksConclusive: substancial e sem adiamento é conclusiva', () => {
  assert.equal(answerLooksConclusive(CONCLUSIVE), true);
});

test('answerLooksConclusive: resposta curta não é conclusiva', () => {
  assert.equal(answerLooksConclusive('Ok, pronto.'), false);
});

test('answerLooksConclusive: linguagem de adiamento não é conclusiva', () => {
  assert.equal(answerLooksConclusive(CONCLUSIVE + ' Próximo passo: vou gerar o arquivo.'), false);
});

test('não descarta uma resposta conclusiva quando nenhum arquivo era esperado', () => {
  const repair = shouldRepairExecution({
    requiresExecution: true,
    requiresOutput: false,
    toolsAvailable: true,
    executedToolCalls: 0,
    outputsBefore: new Map(),
    outputsAfter: [],
    responseText: CONCLUSIVE
  });
  assert.equal(repair, false);
});

test('ainda repara quando um arquivo era esperado e não foi criado (sem regressão)', () => {
  const repair = shouldRepairExecution({
    requiresExecution: true,
    requiresOutput: true,
    toolsAvailable: true,
    executedToolCalls: 0,
    outputsBefore: new Map(),
    outputsAfter: [],
    responseText: CONCLUSIVE
  });
  assert.equal(repair, true);
});

test('ainda repara quando a resposta é fina e nenhuma ferramenta foi chamada', () => {
  const repair = shouldRepairExecution({
    requiresExecution: true,
    requiresOutput: false,
    toolsAvailable: true,
    executedToolCalls: 0,
    outputsBefore: new Map(),
    outputsAfter: [],
    responseText: 'Feito.'
  });
  assert.equal(repair, true);
});

test('sem execução exigida ou sem ferramentas, não repara', () => {
  assert.equal(shouldRepairExecution({ requiresExecution: false, toolsAvailable: true, outputsBefore: new Map(), outputsAfter: [] }), false);
  assert.equal(shouldRepairExecution({ requiresExecution: true, toolsAvailable: false, outputsBefore: new Map(), outputsAfter: [] }), false);
});
