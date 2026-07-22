import assert from 'node:assert/strict';
import test from 'node:test';
import { executionState, finalExecutionState, isTerminalExecutionState } from './executionState.js';

test('somente estados finais são terminais', () => {
  assert.equal(isTerminalExecutionState('validating'), false);
  assert.equal(isTerminalExecutionState('completed'), true);
  assert.equal(isTerminalExecutionState('recoverable_error'), true);
});

test('conclusão nunca vence uma falha ou espera pelo usuário', () => {
  assert.equal(finalExecutionState({ providerFailure: true }), 'recoverable_error');
  assert.equal(finalExecutionState({ awaitingUserReply: true }), 'awaiting_user');
  assert.equal(finalExecutionState({ incomplete: true }), 'fatal_error');
  assert.equal(finalExecutionState({}), 'completed');
});

test('estado desconhecido é rejeitado', () => {
  assert.throws(() => executionState('silêncio_do_stream'), /desconhecido/);
});
