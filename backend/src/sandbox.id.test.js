import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-sandbox-id-tests';
const { assertConversationId, isConversationId, workspaceFor, sandboxPolicy } = await import('./sandbox.js');

test('accepts the NanoID-shaped conversation identifiers used by the app', () => {
  assert.equal(isConversationId('bK1_6d9X-k2M8qPzvL3aQ'), true);
  assert.equal(assertConversationId('bK1_6d9X-k2M8qPzvL3aQ'), 'bK1_6d9X-k2M8qPzvL3aQ');
});

test('rejects traversal and other unsafe conversation identifiers before creating a workspace', () => {
  assert.equal(isConversationId('../data'), false);
  assert.throws(() => workspaceFor('../data'), /invalido/i);
  assert.throws(() => workspaceFor('short'), /invalido/i);
});

test('sandbox network is off by default and part of the session policy key', () => {
  const closed = sandboxPolicy({});
  const open = sandboxPolicy({ networkEnabled: true });
  assert.equal(closed.networkEnabled, false);
  assert.equal(open.networkEnabled, true);
  assert.notEqual(closed.key, open.key);
  assert.match(closed.key, /network:off/);
  assert.match(open.key, /network:on/);
});
