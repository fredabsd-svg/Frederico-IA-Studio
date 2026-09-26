import assert from 'node:assert/strict';
import test from 'node:test';
import { copilotChatBody, copilotModelField, MAX_MODEL_REF_CHARS } from './useCopilotChat.js';

// Configurações → Companion diz: "deixe o modelo em branco para acompanhar o
// modelo da conversa". Para isso o backend precisa RECEBER o modelo da conversa
// aberta — antes o corpo da requisição nunca o levava e o copiloto caía no
// provedor padrão da conta.

test('o corpo do chat do copiloto leva o modelo da conversa aberta', () => {
  const body = copilotChatBody('oi', { shareContext: true, conversationId: 'c1' }, 'prov::modelo-x');
  assert.deepEqual(body, { text: 'oi', shareContext: true, conversationId: 'c1', model: 'prov::modelo-x' });
});

test('sem modelo (ou com valor inválido) o campo não é enviado', () => {
  assert.deepEqual(copilotChatBody('oi', {}, null), { text: 'oi', shareContext: false, conversationId: null });
  assert.deepEqual(copilotModelField('   '), {});
  assert.deepEqual(copilotModelField(42), {});
  assert.deepEqual(copilotModelField('x'.repeat(MAX_MODEL_REF_CHARS + 1)), {});
  assert.deepEqual(copilotModelField(' prov::m '), { model: 'prov::m' });
});

test('shareContext só é verdadeiro quando pedido explicitamente', () => {
  assert.equal(copilotChatBody('oi', { shareContext: 'sim' }).shareContext, false);
});
