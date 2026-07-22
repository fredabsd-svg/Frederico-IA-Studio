import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSISTANT_TOOL_NAMES,
  allowedAssistantToolNames,
  explicitlyAuthorizesSandboxNetwork,
  isToolCallAllowed
} from './assistantPolicy.js';

test('campo de ferramentas ausente mantém o padrão compatível', () => {
  assert.deepEqual(allowedAssistantToolNames(undefined), [...ASSISTANT_TOOL_NAMES]);
});

test('lista vazia significa nenhuma ferramenta', () => {
  assert.deepEqual(allowedAssistantToolNames([]), []);
});

test('ferramentas desconhecidas são descartadas e duplicatas removidas', () => {
  assert.deepEqual(allowedAssistantToolNames(['read_file', 'hack', 'read_file']), ['read_file']);
});

test('executor reconhece somente ferramentas realmente oferecidas', () => {
  const tools = [{ type: 'function', function: { name: 'read_file' } }];
  assert.equal(isToolCallAllowed('read_file', tools), true);
  assert.equal(isToolCallAllowed('bash', tools), false);
});

test('rede do sandbox exige autorização explícita e atual', () => {
  assert.equal(explicitlyAuthorizesSandboxNetwork('Instale a dependência com npm install.'), true);
  assert.equal(explicitlyAuthorizesSandboxNetwork('Baixe o pacote pela internet.'), true);
  assert.equal(explicitlyAuthorizesSandboxNetwork('Acesse https://example.com para baixar o arquivo.'), true);
  assert.equal(explicitlyAuthorizesSandboxNetwork('Execute git clone https://github.com/acme/app.'), true);
  assert.equal(explicitlyAuthorizesSandboxNetwork('Pesquise esse assunto na internet.'), false);
  assert.equal(explicitlyAuthorizesSandboxNetwork('Use o pacote pandas já instalado.'), false);
  assert.equal(explicitlyAuthorizesSandboxNetwork('Não instale pacote nem acesse a internet.'), false);
  assert.equal(explicitlyAuthorizesSandboxNetwork('Analise o arquivo anexado.'), false);
});
