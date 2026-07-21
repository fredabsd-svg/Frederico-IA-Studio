import assert from 'node:assert/strict';
import test from 'node:test';

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/tmp/frederico-modelunavail-tests';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';

const { isModelUnavailableError, isUnsupportedToolError } = await import('./modelCapabilities.js');
const { friendlyApiError } = await import('./agent.js');

// 404 puro (modelo removido/renomeado) → indisponível, aciona failover.
test('isModelUnavailableError reconhece 404 do provedor', () => {
  assert.equal(isModelUnavailableError({ status: 404, error: { message: 'No endpoints found for foo/bar:free' } }), true);
  assert.equal(isModelUnavailableError({ status: 404 }), true);
});

// Texto de "not a valid model id" mesmo sem status 404 claro.
test('isModelUnavailableError reconhece pelo texto do erro', () => {
  assert.equal(isModelUnavailableError({ error: { message: 'google/gemma-4-31b-it:free is not a valid model ID' } }), true);
  assert.equal(isModelUnavailableError({ message: 'No allowed providers are available for the selected model.' }), true);
});

// Falta de FERRAMENTAS tem tratamento próprio — NÃO deve ser tratado como
// "modelo indisponível" (senão faríamos failover em vez da mensagem certa).
test('isModelUnavailableError ignora erro de ferramentas', () => {
  const toolErr = { status: 404, error: { message: 'No endpoints found that support tool use.' } };
  assert.equal(isUnsupportedToolError(toolErr), true);
  assert.equal(isModelUnavailableError(toolErr), false);
});

// Erros comuns não são "modelo indisponível".
test('isModelUnavailableError não dispara para 401/429/500', () => {
  assert.equal(isModelUnavailableError({ status: 401, error: { message: 'invalid key' } }), false);
  assert.equal(isModelUnavailableError({ status: 429, error: { message: 'rate limited' } }), false);
  assert.equal(isModelUnavailableError({ status: 500, error: { message: 'boom' } }), false);
});

// A mensagem amigável do 404 agora inclui o motivo real do provedor.
test('friendlyApiError expõe o motivo real no 404', () => {
  const msg = friendlyApiError({ status: 404, error: { message: 'qux/quux:free is not a valid model ID' } });
  assert.match(msg, /não encontrado ou indisponível/i);
  assert.match(msg, /is not a valid model ID/);
});
