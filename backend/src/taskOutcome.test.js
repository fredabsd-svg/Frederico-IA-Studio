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

// PERGUNTA AO USUÁRIO não é falha: o agente pediu uma decisão e parou. Antes, um
// turno assim podia cair em `incomplete` e a rota emitia `execution_failed` —
// a mensagem aparecia como erro no chat, com botão de "Reenviar", em vez de
// mostrar a pergunta para responder.
test('uma pergunta ao usuário fica como waiting_user, não como erro', () => {
  assert.deepEqual(classifyTaskResult({
    text: 'Posso alterar também o banco?',
    execution: { state: 'awaiting_user', terminal: true }
  }), { status: 'waiting_user', progress: 'Aguardando resposta', error: null });
});

test('awaiting_user tem precedência sobre incomplete (não emite execution_failed)', () => {
  const outcome = classifyTaskResult({
    incomplete: true,
    failureMessage: 'A execução terminou sem produzir um resultado verificável.',
    execution: { state: 'awaiting_user', terminal: true }
  });
  assert.equal(outcome.status, 'waiting_user');
  assert.equal(outcome.error, null);
});

test('cancelamento continua vencendo awaiting_user', () => {
  const outcome = classifyTaskResult({ stopped: true, execution: { state: 'awaiting_user' } });
  assert.equal(outcome.status, 'canceled');
});
