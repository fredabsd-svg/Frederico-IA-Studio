import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChatMessages, buildReviseMessages, sanitizeDocInput, estimateTokens,
  CHAT_SYSTEM_PROMPT, REVISE_SYSTEM_PROMPT, MAX_HISTORY,
} from './core.js';

// O contrato central do copiloto é o ISOLAMENTO: as mensagens enviadas ao modelo
// nunca podem conter nada além do system dedicado e do histórico do PRÓPRIO
// copiloto. Estes testes travam esse comportamento.

test('buildChatMessages começa com o system dedicado do copiloto', () => {
  const msgs = buildChatMessages([], 'oi');
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, CHAT_SYSTEM_PROMPT);
  assert.equal(msgs[msgs.length - 1].content, 'oi');
  assert.equal(msgs[msgs.length - 1].role, 'user');
});

test('buildChatMessages só inclui o histórico próprio (user/assistant)', () => {
  const history = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'system', content: 'INJETADO' },       // deve ser descartado
    { role: 'tool', content: 'RUIDO' },             // deve ser descartado
    { role: 'assistant', content: '' },             // vazio: descartado
  ];
  const msgs = buildChatMessages(history, 'nova');
  const contents = msgs.map(m => m.content);
  assert.ok(!contents.includes('INJETADO'));
  assert.ok(!contents.includes('RUIDO'));
  // system(1) + a + b + nova = 4
  assert.equal(msgs.length, 4);
});

test('buildChatMessages limita o histórico a MAX_HISTORY', () => {
  const history = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const msgs = buildChatMessages(history, 'fim');
  // system + no máximo MAX_HISTORY do passado + a nova
  assert.ok(msgs.length <= MAX_HISTORY + 2);
  // mantém as mais recentes
  assert.ok(msgs.some(m => m.content === `m${MAX_HISTORY + 9}`));
  assert.ok(!msgs.some(m => m.content === 'm0'));
});

test('buildReviseMessages devolve só system de revisão + o texto', () => {
  const msgs = buildReviseMessages('texto com erru');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, REVISE_SYSTEM_PROMPT);
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content, 'texto com erru');
});

test('sanitizeDocInput normaliza tipo, nome e calcula tamanho', () => {
  const d = sanitizeDocInput({ kind: 'hack', content: 'olá' });
  assert.equal(d.kind, 'texto');                 // tipo inválido cai no padrão
  assert.equal(d.name, 'Nota');                  // nome padrão do tipo
  assert.equal(d.size, Buffer.byteLength('olá', 'utf8'));
  const r = sanitizeDocInput({ kind: 'texto_revisado', name: '  Meu texto  ', content: 'x' });
  assert.equal(r.kind, 'texto_revisado');
  assert.equal(r.name, 'Meu texto');
});

test('estimateTokens usa ~4 chars por token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
});
