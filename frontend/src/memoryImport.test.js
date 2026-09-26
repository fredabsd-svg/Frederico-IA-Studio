import assert from 'node:assert/strict';
import test from 'node:test';
import { importDoneLabel, importFactsLabel, importProgressLabel } from './memoryImport.js';

test('com chave própria, conta os fatos aprendidos', () => {
  assert.equal(importFactsLabel({ facts: 7, factsSkipped: null }), '7 fatos aprendidos');
  assert.equal(importDoneLabel({ total: 3, chunks: 40, facts: 7 }),
    'Importado: 3 conversa(s), 40 trechos indexados, 7 fatos aprendidos.');
});

test('modo gratuito diz por que não há fatos, em vez de "0 fatos aprendidos"', () => {
  const s = { file: 'chat.json', processed: 1, total: 2, chunks: 5, facts: 0, factsSkipped: 'free_mode' };
  assert.doesNotMatch(importProgressLabel(s), /0 fatos aprendidos/);
  assert.match(importProgressLabel(s), /não extraídos no modo gratuito/);
  assert.match(importDoneLabel({ ...s, factsSkipped: 'no_provider' }), /nenhuma chave de IA configurada/);
});
