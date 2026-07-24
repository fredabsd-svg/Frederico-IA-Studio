import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_TOOL_NAMES,
  allowedAssistantToolNames,
  explicitlyAuthorizesSandboxNetwork,
  resolveSandboxNetwork,
  SANDBOX_NET_AUTO,
  SANDBOX_NET_ON,
  SANDBOX_NET_OFF,
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

test('política automática respeita o texto do pedido', () => {
  assert.equal(resolveSandboxNetwork(SANDBOX_NET_AUTO, 'npm install left-pad'), true);
  assert.equal(resolveSandboxNetwork(SANDBOX_NET_AUTO, 'Analise o arquivo anexado.'), false);
});

test('política "sempre ligada" abre a rede independente do texto', () => {
  assert.equal(resolveSandboxNetwork(SANDBOX_NET_ON, 'Analise o arquivo anexado.'), true);
  assert.equal(resolveSandboxNetwork(SANDBOX_NET_ON, ''), true);
});

test('política "sempre desligada" mantém a rede fechada mesmo com pedido explícito', () => {
  assert.equal(resolveSandboxNetwork(SANDBOX_NET_OFF, 'npm install left-pad'), false);
  assert.equal(resolveSandboxNetwork(SANDBOX_NET_OFF, 'Execute git clone https://github.com/acme/app.'), false);
});

test('política ausente/desconhecida cai no automático', () => {
  assert.equal(resolveSandboxNetwork(undefined, 'npm install left-pad'), true);
  assert.equal(resolveSandboxNetwork(undefined, 'Analise o arquivo anexado.'), false);
});

test('migração de compatibilidade restaura ferramentas de todo assistente legado vazio', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(here, '../../migrations/011_restore_legacy_assistant_tools.sql'), 'utf8');
  assert.match(sql, /UPDATE assistants/i);
  assert.match(sql, /BTRIM\(tools\)/i);
  assert.doesNotMatch(sql, /WHERE\s+name\s+IN/i);
  for (const name of ASSISTANT_TOOL_NAMES) assert.ok(sql.includes(`"${name}"`), `migration deveria incluir ${name}`);
});
