import assert from 'node:assert/strict';
import test from 'node:test';
import { rankBySimilarity, chunkEmbedText } from './semantic.js';

// Cosseno "de mentira": os vetores são só rótulos; a proximidade é 1 quando
// iguais, 0 caso contrário. Assim testamos o ranqueamento sem carregar modelo.
const fakeCos = (a, b) => (a === b ? 1 : 0);

const chunks = [
  { page: 3, content: 'A', tokens: 10 },
  { page: 1, content: 'B', tokens: 10 },
  { page: 2, content: 'C', tokens: 10 },
];

test('rankBySimilarity escolhe o chunk mais parecido com a pergunta', () => {
  const vectors = ['va', 'vb', 'vc'];
  const picked = rankBySimilarity(chunks, vectors, 'vb', 10, fakeCos);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].content, 'B');
});

test('rankBySimilarity respeita o orçamento e reordena por página', () => {
  const vectors = ['vx', 'vx', 'vx']; // todos "iguais" à pergunta
  const picked = rankBySimilarity(chunks, vectors, 'vx', 20, fakeCos);
  assert.equal(picked.length, 2);               // 2 x 10 tokens cabem em 20
  assert.ok(picked[0].page <= picked[1].page);  // reordenado por página
});

test('rankBySimilarity sem vetores não quebra (todos score baixo, ordem estável)', () => {
  const picked = rankBySimilarity(chunks, [null, null, null], 'q', 15, fakeCos);
  assert.equal(picked.length, 1);
});

test('rankBySimilarity sem queryVec devolve na ordem do documento dentro do orçamento', () => {
  const picked = rankBySimilarity(chunks, ['a', 'b', 'c'], null, 10, fakeCos);
  assert.equal(picked.length, 1);
});

test('chunkEmbedText combina seção e conteúdo e limita o tamanho', () => {
  const t = chunkEmbedText({ section: 'Débitos', content: 'x'.repeat(5000) });
  assert.ok(t.startsWith('Débitos'));
  assert.ok(t.length <= 2000);
});
