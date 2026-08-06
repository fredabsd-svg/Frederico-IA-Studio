// F-06: extração de memória herda o modelRef da conversa. Cobre
// resolveExtractModel (precedência: EXTRACT_MODEL > modelRef > default)
// e estimateTokens (consciência de alfabeto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExtractModel, estimateTokens } from './indexer.js';
import { rawModelId } from '../modelRef.js';
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

// Regressão: a conversa entrega o modelo na forma COMPLETA (`<provedor>::<modelo>`
// — é o `chosenModel` do loop). O provedor não conhece esse prefixo; mandá-lo
// inteiro devolve o mesmo 404 de "modelo não pertence a este provedor" que esta
// frente veio corrigir. Quem chama precisa passar por `rawModelId` antes da API,
// como o caminho principal faz em loop.js.
test('o modelRef da conversa vem com prefixo de provedor, e a API recebe só o modelo', () => {
  const daConversa = 'prov_abc123::deepseek/deepseek-chat';
  assert.equal(resolveExtractModel(daConversa), daConversa, 'a resolução preserva a referência completa');
  assert.equal(rawModelId(resolveExtractModel(daConversa)), 'deepseek/deepseek-chat',
    'o que vai para o provedor não pode carregar o prefixo');
});

test('modelo sem prefixo atravessa rawModelId inalterado', () => {
  assert.equal(rawModelId(resolveExtractModel('deepseek/deepseek-chat')), 'deepseek/deepseek-chat');
});
