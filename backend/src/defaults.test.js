// Constante canônica do modelo padrão. Centralizada em `defaults.js` para
// acabar com a divergência que existia entre seed/assistants (usavam
// 'deepseek/deepseek-chat' hardcoded) e schedules/inbox/conversations/helpers/
// memory/indexer (usavam DEEPSEEK_MODEL || 'deepseek-chat' do env).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MODEL_REF, resolveDefaultModelRef } from './defaults.js';

test('DEFAULT_MODEL_REF é o id canônico do modelo padrão (formato OpenRouter)', () => {
  // O formato canônico vem do seed e dos testes E2E (e2e/fixtures/provedorFalso.mjs);
  // é o que `getUserProvider` recebe por padrão quando o usuário não disse
  // qual modelo usar. Usar um id nativo aqui quebraria os testes E2E.
  assert.equal(DEFAULT_MODEL_REF, 'deepseek/deepseek-chat');
});

test('resolveDefaultModelRef devolve o env quando DEEPSEEK_MODEL está setado', () => {
  const prev = process.env.DEEPSEEK_MODEL;
  process.env.DEEPSEEK_MODEL = 'deepseek-chat';
  try { assert.equal(resolveDefaultModelRef(), 'deepseek-chat'); }
  finally { if (prev === undefined) delete process.env.DEEPSEEK_MODEL; else process.env.DEEPSEEK_MODEL = prev; }
});

test('resolveDefaultModelRef cai no default canônico quando DEEPSEEK_MODEL está vazio', () => {
  const prev = process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_MODEL;
  try { assert.equal(resolveDefaultModelRef(), DEFAULT_MODEL_REF); }
  finally { if (prev !== undefined) process.env.DEEPSEEK_MODEL = prev; }
});
