import assert from 'node:assert/strict';
import test from 'node:test';
import { takeSseEvents } from './sse.js';

test('parses complete SSE events and ignores heartbeat comments', () => {
  const result = takeSseEvents(': ping\n\ndata: {"type":"delta","content":"Ola"}\n\npartial');
  assert.deepEqual(result.events, [{ type: 'delta', content: 'Ola' }]);
  assert.equal(result.rest, 'partial');
});

test('accepts CRLF event boundaries used by some proxies', () => {
  const result = takeSseEvents('data: {"type":"files","files":[]}\r\n\r\n');
  assert.deepEqual(result.events, [{ type: 'files', files: [] }]);
  assert.equal(result.rest, '');
});

test('consumes the final event even when a proxy omits the trailing separator', () => {
  const result = takeSseEvents('data: {"type":"saved","assistantMessageId":"a1"}', { flush: true });
  assert.deepEqual(result.events, [{ type: 'saved', assistantMessageId: 'a1' }]);
  assert.equal(result.rest, '');
});

test('does not crash on a malformed event', () => {
  const result = takeSseEvents('data: not-json\n\n', { flush: true });
  assert.deepEqual(result.events, []);
});
