import assert from 'node:assert/strict';
import test from 'node:test';

import { SUBAGENT_TOOL, delegationSummary, groupExecutionSteps } from './executionSteps.js';

const step = (over = {}) => ({ name: 'bash', status: 'done', ...over });

test('sem sub-agentes, a lista sai igual à ordem original', () => {
  const steps = [step({ id: 'a' }), step({ id: 'b', name: 'run_python' })];
  assert.deepEqual(groupExecutionSteps(steps), [
    { s: steps[0], i: 0, depth: 0 },
    { s: steps[1], i: 1, depth: 0 }
  ]);
});

test('as etapas do sub-agente ficam recuadas dentro da delegação', () => {
  const steps = [
    step({ id: 'd1', name: SUBAGENT_TOOL }),
    step({ id: 'd1:t1', parentId: 'd1', subagent: 'Fiscal', name: 'read_file' }),
    step({ id: 'z', name: 'write_file' })
  ];
  assert.deepEqual(groupExecutionSteps(steps).map(r => [r.i, r.depth]), [[0, 0], [1, 1], [2, 0]]);
});

// O caso que motivou o agrupamento: em paralelo, as etapas dos dois filhos
// chegam INTERCALADAS no stream (cada um termina quando termina).
test('duas delegações em paralelo não misturam as etapas dos filhos', () => {
  const steps = [
    step({ id: 'dA', name: SUBAGENT_TOOL, status: 'running' }),
    step({ id: 'dB', name: SUBAGENT_TOOL, status: 'running' }),
    step({ id: 'dA:1', parentId: 'dA', subagent: 'Fiscal' }),
    step({ id: 'dB:1', parentId: 'dB', subagent: 'Contábil' }),
    step({ id: 'dA:2', parentId: 'dA', subagent: 'Fiscal' })
  ];
  const rows = groupExecutionSteps(steps);
  assert.deepEqual(rows.map(r => r.s.id), ['dA', 'dA:1', 'dA:2', 'dB', 'dB:1']);
  assert.deepEqual(rows.map(r => r.depth), [0, 1, 1, 0, 1]);
});

test('etapa órfã continua na lista, no lugar dela', () => {
  // Pai fora deste conjunto de blocos (stream parcial): some seria pior.
  const steps = [step({ id: 'x' }), step({ id: 'y', parentId: 'sumiu', subagent: 'Fiscal' })];
  const rows = groupExecutionSteps(steps);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.depth), [0, 1]);
});

test('nenhuma etapa é perdida nem duplicada no agrupamento', () => {
  const steps = [
    step({ id: 'd1', name: SUBAGENT_TOOL }),
    step({ id: 'd1:1', parentId: 'd1', subagent: 'Fiscal' }),
    step({ id: 'solta' }),
    step({ id: 'd1:2', parentId: 'd1', subagent: 'Fiscal' })
  ];
  const rows = groupExecutionSteps(steps);
  assert.equal(rows.length, steps.length);
  assert.equal(new Set(rows.map(r => r.i)).size, steps.length);
});

test('etapas sem id (stream antigo) não quebram o agrupamento', () => {
  const steps = [step(), step({ name: 'run_python' })];
  assert.deepEqual(groupExecutionSteps(steps).map(r => r.depth), [0, 0]);
});

test('delegationSummary conta as delegações, as em voo e quem executou', () => {
  const steps = [
    step({ id: 'dA', name: SUBAGENT_TOOL, status: 'running' }),
    step({ id: 'dB', name: SUBAGENT_TOOL, status: 'done' }),
    step({ id: 'dA:1', parentId: 'dA', subagent: 'Fiscal' }),
    step({ id: 'dA:2', parentId: 'dA', subagent: 'Fiscal' }),
    step({ id: 'dB:1', parentId: 'dB', subagent: 'Contábil' })
  ];
  assert.deepEqual(delegationSummary(steps), { total: 2, running: 1, names: ['Fiscal', 'Contábil'] });
});

test('sem delegação, o resumo vem zerado', () => {
  assert.deepEqual(delegationSummary([step(), step()]), { total: 0, running: 0, names: [] });
});
