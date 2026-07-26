// Atribuição do erro do provedor.
//
// Caso real (2026-07): a conta tinha DeepSeek e OpenRouter. A chave do OpenRouter
// estava válida — 345 modelos sincronizados no mesmo minuto — mas a chamada caiu
// na DeepSeek, porque o modelo do assistente é um id SEM prefixo `<provedor>::`
// e `getUserProvider` recai no provedor mais antigo quando não acha o id em
// catálogo nenhum. A mensagem dizia só "Chave da API inválida ou expirada", então
// o usuário conferia a chave do OpenRouter (a que estava certa) e concluía que o
// app é que estava errado.
import assert from 'node:assert/strict';
import test from 'node:test';
import { friendlyApiError, tagProviderError } from './provider.js';

test('401 sem contexto continua compreensível', () => {
  const msg = friendlyApiError({ status: 401 });
  assert.match(msg, /Chave da API/);
  assert.match(msg, /Configurações → Provedor de IA/);
  assert.doesNotMatch(msg, /undefined|null/);
});

test('401 diz QUAL provedor e QUAL modelo foram recusados', () => {
  const err = tagProviderError({ status: 401 }, { providerName: 'DeepSeek', model: 'deepseek/deepseek-chat' });
  const msg = friendlyApiError(err);
  assert.match(msg, /DeepSeek/);
  assert.match(msg, /deepseek\/deepseek-chat/);
  // O ponto da correção: não pode sobrar a impressão de que é "a" chave — com
  // mais de um provedor, é a chave DESSE provedor.
  assert.match(msg, /mais de um provedor/);
});

test('402 também nomeia o provedor, sem o par genérico "OpenRouter/DeepSeek"', () => {
  const msg = friendlyApiError(tagProviderError({ status: 402 }, { providerName: 'OpenRouter' }));
  assert.match(msg, /OpenRouter/);
  assert.doesNotMatch(msg, /OpenRouter\/DeepSeek/);
});

test('402 sem contexto preserva a dica antiga', () => {
  assert.match(friendlyApiError({ status: 402 }), /OpenRouter\/DeepSeek/);
});

test('tagProviderError não sobrescreve uma atribuição já feita', () => {
  // O erro sobe por vários caminhos (retomada, modelo de reserva, throw final);
  // quem marcou primeiro estava mais perto da chamada que realmente falhou.
  const err = tagProviderError({ status: 401 }, { providerName: 'DeepSeek', model: 'x' });
  tagProviderError(err, { providerName: 'OpenRouter', model: 'y' });
  assert.equal(err.providerName, 'DeepSeek');
  assert.equal(err.providerModel, 'x');
});

test('tagProviderError aguenta erro que não é objeto e contexto vazio', () => {
  assert.equal(tagProviderError(null, { providerName: 'X' }), null);
  assert.equal(tagProviderError('falhou'), 'falhou');
  const err = tagProviderError({ status: 401 }, {});
  assert.equal(err.providerName, undefined);
  assert.doesNotMatch(friendlyApiError(err), /provedor ""/);
});

test('os outros status não regridem', () => {
  assert.match(friendlyApiError({ status: 429 }), /Limite de uso atingido/);
  assert.match(friendlyApiError({ status: 503 }), /instável/);
  assert.match(friendlyApiError({ code: 'CONVERSATION_BUSY' }), /já está processando/);
});
