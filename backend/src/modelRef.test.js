import test from 'node:test';
import assert from 'node:assert/strict';
import { makeModelRef, parseModelRef, rawModelId } from './modelRef.js';

test('model refs preserve provider ownership without changing the raw model id', () => {
  const ref = makeModelRef('provider-123', 'meta/llama-3.3');
  assert.equal(ref, 'provider-123::meta/llama-3.3');
  assert.deepEqual(parseModelRef(ref), { ref, providerId: 'provider-123', modelId: 'meta/llama-3.3' });
  assert.equal(rawModelId(ref), 'meta/llama-3.3');
  assert.equal(rawModelId('legacy-model'), 'legacy-model');
});
