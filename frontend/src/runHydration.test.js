import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRunsToMessages, blocksFromRunSteps } from './runHydration.js';

const STEP = {
  id: 'a', name: 'bash', preview: 'npm test', status: 'done',
  started: '2026-08-07T12:00:00.000Z', ended: '2026-08-07T12:00:05.000Z',
  result: '{"exitCode":0}'
};

test('blocksFromRunSteps produz blocos na forma do caminho ao vivo, com epoch-ms', () => {
  const blocks = blocksFromRunSteps([STEP], 'Pronto.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'tool');
  assert.equal(blocks[0].status, 'done');
  assert.equal(blocks[0].started, Date.parse(STEP.started));
  assert.equal(blocks[0].ended - blocks[0].started, 5000);
  assert.deepEqual(blocks[1], { type: 'text', content: 'Pronto.' });
  // sem texto, sem bloco de texto
  assert.equal(blocksFromRunSteps([STEP], ' ').length, 1);
});

test('applyRunsToMessages casa por messageId e preserva mensagens com blocks ao vivo', () => {
  const runs = [{ runId: 'r1', messageId: 'm2', state: 'completed', steps: [STEP], plan: { steps: [{ id: '1', title: 'x', status: 'completed', evidence: 'ok' }] } }];
  const messages = [
    { id: 'm1', role: 'user', content: 'faz' },
    { id: 'm2', role: 'assistant', content: 'Feito.', execution: { state: 'completed', runId: 'r1' } },
    { id: 'm3', role: 'assistant', content: 'já tinha blocks', blocks: [{ type: 'text', content: 'vivo' }] }
  ];
  const result = applyRunsToMessages(messages, runs);
  assert.equal(result[0].blocks, undefined, 'mensagem de usuário intocada');
  assert.equal(result[1].blocks.length, 2, 'etapa + texto');
  assert.equal(result[1].plan.steps.length, 1, 'plano do run entra quando a mensagem não tem');
  assert.equal(result[2].blocks[0].content, 'vivo', 'blocks ao vivo têm prioridade');
});

test('applyRunsToMessages casa pelo runId do execution_meta quando falta messageId', () => {
  const runs = [{ runId: 'r9', messageId: null, state: 'recoverable_error', steps: [{ ...STEP, status: 'interrupted' }] }];
  const messages = [{ id: 'mX', role: 'assistant', content: '', execution: { state: 'recoverable_error', runId: 'r9' } }];
  const result = applyRunsToMessages(messages, runs);
  assert.equal(result[0].blocks.length, 1);
  assert.equal(result[0].blocks[0].status, 'interrupted', 'interrupção persistida não vira sucesso');
});

test('sem runs, as mensagens voltam intactas (mesma referência)', () => {
  const messages = [{ id: 'm1', role: 'assistant', content: 'x', execution: { state: 'completed' } }];
  assert.equal(applyRunsToMessages(messages, []), messages);
});
