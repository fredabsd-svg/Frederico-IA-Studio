import assert from 'node:assert/strict';
import test from 'node:test';
import { isLowSignalTurn } from './retrievalPolicy.js';

test('ignores external context for greetings and acknowledgements', () => {
  for (const text of ['oi', 'Ola, tudo bem?', 'bom dia!', 'obrigado', 'ok']) {
    assert.equal(isLowSignalTurn(text), true, text);
  }
});

test('keeps external context available for actual requests', () => {
  for (const text of ['oi, analise meu workspace', 'qual modelo devo usar para PDF?', 'lembre que prefiro respostas curtas']) {
    assert.equal(isLowSignalTurn(text), false, text);
  }
});
