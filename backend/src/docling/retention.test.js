import assert from 'node:assert/strict';
import test from 'node:test';
import { isExpired } from './retention.js';

const now = Date.parse('2026-07-23T12:00:00Z');

test('isExpired: retenção desligada (0) nunca expira', () => {
  assert.equal(isExpired('2020-01-01T00:00:00Z', 0, now), false);
  assert.equal(isExpired('2020-01-01T00:00:00Z', -5, now), false);
});

test('isExpired: mais antigo que a retenção expira', () => {
  const old = '2026-07-01T12:00:00Z'; // 22 dias atrás
  assert.equal(isExpired(old, 30, now), false);
  assert.equal(isExpired(old, 10, now), true);
});

test('isExpired: exatamente no limite não expira (precisa passar)', () => {
  const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isExpired(tenDaysAgo, 10, now), false);
  assert.equal(isExpired(tenDaysAgo, 9, now), true);
});

test('isExpired: data inválida não expira (seguro)', () => {
  assert.equal(isExpired('não-é-data', 10, now), false);
  assert.equal(isExpired(null, 10, now), false);
});
