import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-agent-control-tests';
const {
  ConversationBusyError,
  acquireConversationControl,
  isConversationActive,
  releaseConversationControl,
  setControl
} = await import('./agent.js');

test('prevents overlapping executions in the same conversation', () => {
  const id = 'control-test-conversation';
  const control = acquireConversationControl(id);
  try {
    assert.equal(isConversationActive(id), true);
    assert.throws(() => acquireConversationControl(id), ConversationBusyError);
  } finally {
    releaseConversationControl(id, control);
  }
  assert.equal(isConversationActive(id), false);
});

test('does not clear a newer control when an older execution finishes', () => {
  const id = 'control-release-safety';
  const first = acquireConversationControl(id);
  // This simulates a stale cleanup from an old execution without replacing the
  // active slot through the public API.
  releaseConversationControl(id, { paused: false, stopped: false });
  assert.equal(isConversationActive(id), true);
  setControl(id, 'stop');
  assert.equal(first.stopped, true);
  releaseConversationControl(id, first);
  assert.equal(isConversationActive(id), false);
});
