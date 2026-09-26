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

// Revisão 2026-09: avisos que o usuário LÊ (e notas que o modelo lê) saíam sem
// acento — "concluida", "ja", "indisponivel", "saida".
test('avisos de truncamento e de provedor saem com acentuação correta', async () => {
  const { RESPONSE_TRUNCATED_REPAIR_NOTE, RESPONSE_TRUNCATED_NOTICE } = await import('./repair.js');
  const { PROVIDER_TIMEOUT_NOTICE, STREAM_RESUME_NOTE } = await import('./provider.js');
  const textos = [RESPONSE_TRUNCATED_REPAIR_NOTE, RESPONSE_TRUNCATED_NOTICE, PROVIDER_TIMEOUT_NOTICE, STREAM_RESUME_NOTE].join('\n');
  assert.doesNotMatch(textos, /\b(concluida|ja|indisponivel|nao|saida|usuario|verificavel)\b/);
  assert.match(RESPONSE_TRUNCATED_NOTICE, /saída maior/);
  assert.match(PROVIDER_TIMEOUT_NOTICE, /indisponível/);
});
