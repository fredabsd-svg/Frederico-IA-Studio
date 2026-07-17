import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-sandbox-id-tests';
const { assertConversationId, isConversationId, workspaceFor } = await import('./sandbox.js');

test('accepts the NanoID-shaped conversation identifiers used by the app', () => {
  assert.equal(isConversationId('bK1_6d9X-k2M8qPzvL3aQ'), true);
  assert.equal(assertConversationId('bK1_6d9X-k2M8qPzvL3aQ'), 'bK1_6d9X-k2M8qPzvL3aQ');
});

test('rejects traversal and other unsafe conversation identifiers before creating a workspace', () => {
  assert.equal(isConversationId('../data'), false);
  assert.throws(() => workspaceFor('../data'), /invalido/i);
  assert.throws(() => workspaceFor('short'), /invalido/i);
});
