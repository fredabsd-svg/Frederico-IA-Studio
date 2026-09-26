import assert from 'node:assert/strict';
import test from 'node:test';
import { overflowShift } from './useKeepInViewport.js';

test('painel que cabe não se move', () => {
  assert.equal(overflowShift({ left: 700, right: 1380 }, 1440), 0);
});

test('painel que passa da borda direita volta o necessário (com margem)', () => {
  assert.equal(overflowShift({ left: 780, right: 1460 }, 1440), 32);
});

test('nunca empurra o painel para fora da borda esquerda', () => {
  assert.equal(overflowShift({ left: 20, right: 900 }, 600), 8);
});

test('sem medida, nada muda', () => {
  assert.equal(overflowShift(null, 1440), 0);
});
