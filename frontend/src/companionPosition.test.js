import test from 'node:test';
import assert from 'node:assert/strict';
import { clampCompanionPosition, parseCompanionPosition } from './companionPosition.js';

test('parseCompanionPosition rejeita posição incompleta, inválida ou corrompida', () => {
  assert.equal(parseCompanionPosition('{'), null);
  assert.equal(parseCompanionPosition({ x: 20 }), null);
  assert.equal(parseCompanionPosition({ x: null, y: null }), null);
  assert.equal(parseCompanionPosition({ x: Number.NaN, y: 20 }), null);
  assert.deepEqual(parseCompanionPosition('{"x":24,"y":36}'), { x: 24, y: 36 });
});

test('clampCompanionPosition traz o Nino de volta para dentro da tela', () => {
  assert.deepEqual(
    clampCompanionPosition({ x: 2400, y: 1200 }, { width: 1280, height: 720 }, { width: 82, height: 97 }),
    { x: 1190, y: 615 },
  );
  assert.deepEqual(
    clampCompanionPosition({ x: -200, y: -100 }, { width: 1280, height: 720 }, { width: 82, height: 97 }),
    { x: 8, y: 8 },
  );
});

test('clampCompanionPosition respeita a coluna lateral reservada', () => {
  assert.deepEqual(
    clampCompanionPosition(
      { x: 1800, y: 400 },
      { width: 1917, height: 857 },
      { width: 82, height: 97 },
      { right: 58 },
    ),
    { x: 1777, y: 400 },
  );
});
