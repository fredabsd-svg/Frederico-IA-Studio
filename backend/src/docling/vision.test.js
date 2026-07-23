import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPicturesForVision, visualElementsNote } from './vision.js';

const pics = [
  { index: 1, page: 2, file: '/x/1.png' },
  { index: 2, page: 5, file: null, note: 'imagem não pôde ser renderizada' },
  { index: 3, page: 5, file: '/x/3.png' },
];

test('selectPicturesForVision só pega as que têm imagem e respeita o limite', () => {
  const sel = selectPicturesForVision(pics, 5);
  assert.equal(sel.length, 2);
  assert.deepEqual(sel.map(p => p.index), [1, 3]);
  assert.equal(selectPicturesForVision(pics, 1).length, 1);
});

test('visualElementsNote com visão diz que as imagens seguem anexadas', () => {
  const n = visualElementsNote(pics, true);
  assert.match(n, /3 figura/);
  assert.match(n, /páginas 2, 5/);
  assert.match(n, /anexadas/i);
  assert.match(n, /não puderam ser renderizados/i); // 1 sem imagem
});

test('visualElementsNote sem visão avisa para não fingir que interpretou', () => {
  const n = visualElementsNote(pics, false);
  assert.match(n, /NÃO tem visão/i);
  assert.match(n, /modelo com visão/i);
});

test('visualElementsNote sem figuras retorna null', () => {
  assert.equal(visualElementsNote([], true), null);
  assert.equal(visualElementsNote(null, false), null);
});
