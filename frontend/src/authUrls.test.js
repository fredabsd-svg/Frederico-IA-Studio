import assert from 'node:assert/strict';
import test from 'node:test';
import { callbackURLForOrigin } from './authUrls.js';

test('keeps a Tailscale login on the Tailscale origin', () => {
  assert.equal(
    callbackURLForOrigin('https://frederico.example.ts.net'),
    'https://frederico.example.ts.net/'
  );
});

test('keeps a local login on localhost', () => {
  assert.equal(
    callbackURLForOrigin('http://localhost:5173'),
    'http://localhost:5173/'
  );
});

test('rejects non-http callback origins', () => {
  assert.equal(callbackURLForOrigin('javascript:alert(1)'), '/');
  assert.equal(callbackURLForOrigin('not a URL'), '/');
});
