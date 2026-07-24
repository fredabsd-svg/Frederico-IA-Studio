import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePrompt, estimatePromptTokens, buildCoachMessage, PROMPT_ACTIONS } from './promptCoach.js';

test('estimatePromptTokens cresce com o tamanho', () => {
  assert.equal(estimatePromptTokens(''), 0);
  assert.ok(estimatePromptTokens('a'.repeat(400)) >= 100);
});

test('prompt muito curto é sinalizado', () => {
  const a = analyzePrompt('arruma isso');
  assert.ok(a.issues.some(i => i.kind === 'curto') || a.issues.some(i => i.kind === 'ambiguo'));
});

test('detecta ambiguidade', () => {
  const a = analyzePrompt('faça algo para melhorar um pouco isso aí de alguma forma no projeto todo agora');
  assert.ok(a.issues.some(i => i.kind === 'ambiguo'));
});

test('prompt bem estruturado tem score alto e poucos problemas', () => {
  const good = analyzePrompt('Considerando o projeto X e o arquivo db.js, crie uma função que valida CPF. Regras: não use libs externas. Formato de saída: apenas o código em JavaScript.');
  assert.ok(good.structure.hasContext && good.structure.hasObjective && good.structure.hasRules && good.structure.hasFormat);
  assert.ok(good.score >= 70);
});

test('prompt longo sem formato acumula problemas e reduz score', () => {
  const long = analyzePrompt('quero '.repeat(60));
  assert.ok(long.issues.length >= 1);
  assert.ok(long.score <= 70);
});

test('buildCoachMessage monta a instrução preservando o texto do usuário', () => {
  const msg = buildCoachMessage('revisar', 'meu prompt bagunçado');
  assert.match(msg, /Revise o prompt/);
  assert.match(msg, /meu prompt bagunçado/);
  assert.equal(buildCoachMessage('inexistente', 'x'), null);
  assert.ok(PROMPT_ACTIONS.length >= 8);
});
