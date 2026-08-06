// F-06: extração de memória herda o modelRef da conversa. Cobre
// resolveExtractModel (precedência: EXTRACT_MODEL > modelRef > default)
// e estimateTokens (consciência de alfabeto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExtractModel, estimateTokens } from './indexer.js';
import { resolveDefaultModelRef } from '../defaults.js';

test('resolveExtractModel: EXTRACT_MODEL tem precedência sobre modelRef e default', () => {
  process.env.EXTRACT_MODEL = 'openai/gpt-4o-mini';
  assert.equal(resolveExtractModel('anthropic/claude-3.7-sonnet'), 'openai/gpt-4o-mini');
  delete process.env.EXTRACT_MODEL;
});

test('resolveExtractModel: modelRef da conversa prevalece sobre o default', () => {
  const result = resolveExtractModel('anthropic/claude-3.7-sonnet');
  assert.equal(result, 'anthropic/claude-3.7-sonnet');
});

test('resolveExtractModel: sem EXTRACT_MODEL e sem modelRef, cai no default', () => {
  const result = resolveExtractModel(null);
  assert.equal(result, resolveDefaultModelRef());
});

test('resolveExtractModel: modelRef vazio também cai no default', () => {
  const result = resolveExtractModel('');
  assert.equal(result, resolveDefaultModelRef());
});

test('resolveExtractModel: modelRef undefined cai no default', () => {
  const result = resolveExtractModel(undefined);
  assert.equal(result, resolveDefaultModelRef());
});

test('estimateTokens: texto curto', () => {
  assert.ok(estimateTokens('Olá') > 0);
});

test('estimateTokens: texto em português', () => {
  const t = estimateTokens('O usuário prefere respostas curtas e diretas');
  assert.ok(t >= 8, 'deve ter ao menos 8 tokens estimados');
});

test('estimateTokens: CJK consome mais tokens que ASCII de mesmo tamanho', () => {
  const ascii = estimateTokens('Hello World');
  const cjk = estimateTokens('こんにちは世界');
  assert.ok(cjk > ascii, `CJK (${cjk}) deve ser maior que ASCII (${ascii})`);
});

test('estimateTokens: nunca abaixo do piso', () => {
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('a'), 1);
});
