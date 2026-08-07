import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransition, createRunStateTracker, validTransitionsFrom } from './runStateMachine.js';
import { EXECUTION_STATES, isTerminalExecutionState } from './executionState.js';

test('o ciclo real do loop é uma sequência válida', () => {
  // planning → tool_running → processing_result → continuing → tool_running →
  // processing_result → tool_waiting → awaiting_user (o caminho do ask_user).
  const path = ['planning', 'tool_running', 'processing_result', 'continuing', 'tool_running', 'processing_result', 'tool_waiting', 'awaiting_user'];
  let from = 'waiting';
  for (const to of path) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to} deveria ser válida`);
    from = to;
  }
});

test('todo estado não terminal pode terminar; terminal não tem saída', () => {
  for (const state of EXECUTION_STATES) {
    if (isTerminalExecutionState(state)) {
      for (const next of EXECUTION_STATES) {
        assert.equal(canTransition(state, next), false, `terminal ${state} não pode ir para ${next}`);
      }
    } else {
      assert.equal(canTransition(state, 'completed'), true, `${state} deveria poder concluir`);
      assert.equal(canTransition(state, 'stopped'), true, `${state} deveria poder ser parado`);
      assert.equal(canTransition(state, 'fatal_error'), true, `${state} deveria poder falhar`);
    }
  }
});

test('transições de trabalho inválidas são rejeitadas pela tabela', () => {
  assert.equal(canTransition('validating', 'tool_running'), false);
  assert.equal(canTransition('tool_waiting', 'continuing'), false);
  assert.equal(canTransition('waiting', 'tool_running'), false); // sem preparar antes
  assert.equal(canTransition('planning', 'planning'), false);
  assert.equal(canTransition('completed', 'continuing'), false);
  assert.equal(canTransition('inexistente', 'completed'), false);
});

test('o rastreador emite o contrato run_state e conta transições inválidas sem derrubar o run', () => {
  const events = [];
  const recorded = [];
  const tracker = createRunStateTracker({ runId: 'r1', onEvent: (e) => events.push(e), onRecord: (x) => recorded.push(x) });
  tracker.to('planning', 'Preparando');
  tracker.to('tool_running', 'bash', { step: 0, tool: 'bash' });
  assert.equal(tracker.state, 'tool_running');
  assert.equal(tracker.invalidTransitions, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'run_state');
  assert.equal(events[0].execution.state, 'planning');
  assert.equal(events[0].execution.runId, 'r1');
  assert.equal(events[1].execution.tool, 'bash');
  assert.equal(recorded.length, 2);

  // Transição inválida: emitida mesmo assim, mas carimbada e contada.
  const bad = tracker.to('planning', 'volta impossível');
  assert.equal(tracker.invalidTransitions, 1);
  assert.deepEqual(bad.invalidTransition, { from: 'tool_running' });
  assert.equal(tracker.state, 'planning');
});

test('validTransitionsFrom inclui os terminais e exclui saída de terminal', () => {
  assert.ok(validTransitionsFrom('continuing').includes('completed'));
  assert.ok(validTransitionsFrom('continuing').includes('tool_running'));
  assert.deepEqual(validTransitionsFrom('completed'), []);
});

test('falha do gravador durável não interrompe a emissão', () => {
  const events = [];
  const tracker = createRunStateTracker({ runId: 'r2', onEvent: (e) => events.push(e), onRecord: () => { throw new Error('disco cheio'); } });
  assert.doesNotThrow(() => tracker.to('analyzing'));
  assert.equal(events.length, 1);
});
