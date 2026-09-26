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

// ---- Nada de texto interno cru na mensagem ao usuário (Regra 6.2 / 4.4) ----
// O fallback devolvia `err.message` inteiro: um erro do Postgres (constraint,
// SQL, nome de tabela) que subisse até a rota aparecia no chat do usuário.

test('ADVERSARIAL: erro de banco (sem status de provedor) não é ecoado', () => {
  const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "messages_pkey"'), { code: '23505', detail: 'Key (id)=(abc) already exists.' });
  const msg = friendlyApiError(pgErr);
  assert.doesNotMatch(msg, /duplicate key|constraint|messages_pkey|Key \(id\)/);
  assert.match(msg, /inesperado/i);
});

test('ADVERSARIAL: erro genérico com caminho/stack não vaza', () => {
  const msg = friendlyApiError(new Error('ENOENT: no such file or directory, open \'/data/secret/master.key\''));
  assert.doesNotMatch(msg, /master\.key|ENOENT|\/data/);
});

test('falha de conexão/timeout com o provedor tem mensagem própria', () => {
  const conn = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
  assert.match(friendlyApiError(conn), /conectar ao provedor/i);
  const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
  assert.match(friendlyApiError(timeout), /demorou demais|tempo/i);
});

test('texto do provedor passa por saneamento (sem HTML/controle, com teto)', () => {
  const longo = `<script>alert(1)</script>${'x'.repeat(400)}`;
  const msg = friendlyApiError({ status: 404, error: { message: longo } });
  assert.doesNotMatch(msg, /<script>/);
  assert.ok(msg.length < 400, 'o detalhe do provedor tem teto');
});

test('erro 4xx do provedor sem regra própria diz que foi o provedor, com o detalhe saneado', () => {
  const err = tagProviderError({ status: 400, message: '400 bad', error: { message: 'context length exceeded' } }, { providerName: 'OpenRouter' });
  const msg = friendlyApiError(err);
  assert.match(msg, /OpenRouter/);
  assert.match(msg, /context length exceeded/);
});

test('erro do próprio app marcado como exibível mantém a mensagem', () => {
  const err = Object.assign(new Error('A credencial do provedor coordenador não está disponível.'), { userFacing: true });
  assert.equal(friendlyApiError(err), 'A credencial do provedor coordenador não está disponível.');
});

test('ADVERSARIAL: pedaço de chave ecoado pelo provedor é mascarado', () => {
  const msg = friendlyApiError({ status: 403, error: { message: 'Incorrect API key provided: sk-proj-abcdef1234567890. Bearer abcdefghijkl1234' } });
  assert.doesNotMatch(msg, /abcdef1234567890|abcdefghijkl1234/);
  assert.match(msg, /sk-\*\*\*/);
});
