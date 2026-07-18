import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTaskResult } from './taskOutcome.js';

test('marks a stopped task as canceled', () => {
  assert.deepEqual(classifyTaskResult({ stopped: true }), {
    status: 'canceled', progress: 'Cancelada', error: null
  });
});

test('does not report a compatibility refusal as success', () => {
  const outcome = classifyTaskResult({ compatibility: 'tools' });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.progress, 'Modelo incompativel');
});

test('does not report an exhausted provider retry as success', () => {
  const outcome = classifyTaskResult({ providerFailure: true, failureMessage: 'Provedor indisponivel.' });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.error, 'Provedor indisponivel.');
});

test('marks a missing generated file as an incomplete execution', () => {
  const outcome = classifyTaskResult({
    incomplete: true,
    failureMessage: 'A tarefa solicitou um arquivo, mas nenhum arquivo foi criado.'
  });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.progress, 'Nao concluida');
  assert.match(outcome.error, /nenhum arquivo/i);
});

test('keeps a verified agent result as done', () => {
  assert.deepEqual(classifyTaskResult({ text: 'Tudo pronto.' }), {
    status: 'done', progress: 'Concluida', error: null
  });
});
