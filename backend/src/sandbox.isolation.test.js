// Isolamento multiusuário do workspace e do sandbox (Fase 2 da auditoria).
//
// O que estes testes provam, na prática:
//   1) dois usuários com o MESMO id de conversa não compartilham diretório;
//   2) um usuário não alcança o arquivo do outro por caminho relativo;
//   3) mexer nas pastas do PC de UM usuário não derruba o sandbox de outro;
//   4) workspaces do layout antigo (workspaces/<conversa>) são MIGRADOS com os
//      arquivos preservados, e não recriados vazios;
//   5) a seleção de containers órfãos nunca escolhe container de terceiros.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frederico-isolation-'));
process.env.WORKSPACE_ROOT = root;

const {
  workspaceFor,
  userDirName,
  sessionKey,
  destroySandboxesForUser,
  destroyConversation,
  selectOrphanContainers,
  safeJoin,
  _sessionsForTests,
  SANDBOX_LABEL_APP,
  SANDBOX_LABEL_INSTANCE,
  SANDBOX_APP_VALUE
} = await import('./sandbox.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const CONV = 'conversa-compartilhada-1';

test('o mesmo id de conversa em usuários diferentes NÃO compartilha diretório', () => {
  const a = workspaceFor(CONV, 'usuario-a');
  const b = workspaceFor(CONV, 'usuario-b');
  assert.notEqual(a.base, b.base);
  assert.ok(a.base.includes(path.join('users', 'usuario-a')), a.base);
  assert.ok(b.base.includes(path.join('users', 'usuario-b')), b.base);

  fs.writeFileSync(path.join(a.uploads, 'segredo-do-a.txt'), 'dados sensíveis do A');
  assert.deepEqual(fs.readdirSync(b.uploads), [], 'o workspace de B nasce vazio');
});

test('o usuário B não alcança o arquivo do usuário A nem por caminho relativo', () => {
  const b = workspaceFor(CONV, 'usuario-b');
  // ../../usuario-a/... sai da base de B: safeJoin tem de recusar.
  assert.throws(
    () => safeJoin(b.base, `../../usuario-a/${CONV}/uploads/segredo-do-a.txt`),
    /bloqueado por segurança/i
  );
});

test('o escopo de usuário é OBRIGATÓRIO: sem dono, nada é criado', () => {
  assert.throws(() => workspaceFor(CONV), { code: 'WORKSPACE_SCOPE_REQUIRED' });
  assert.throws(() => workspaceFor(CONV, ''), { code: 'WORKSPACE_SCOPE_REQUIRED' });
});

test('userDirName é injetivo: ids diferentes nunca caem na mesma pasta', () => {
  assert.equal(userDirName('abc-123_XY'), 'abc-123_XY'); // já seguro: usa como está
  const a = userDirName('user/../etc');
  const b = userDirName('user/../var');
  assert.notEqual(a, b);
  assert.match(a, /^h_[0-9a-f]{40}$/);
  assert.ok(!a.includes('/') && !a.includes('..'));
});

test('a chave do mapa de sandboxes inclui o dono', () => {
  assert.equal(sessionKey('usuario-a', CONV), `usuario-a/${CONV}`);
  assert.notEqual(sessionKey('usuario-a', CONV), sessionKey('usuario-b', CONV));
});

// ---- Invalidação direcionada (era destroyAllSandboxes global) --------------

function fakeSession(userId, conversationId) {
  const state = { removed: false };
  _sessionsForTests.set(sessionKey(userId, conversationId), {
    container: { id: `container-${userId}`, remove: async () => { state.removed = true; } },
    containerId: `container-${userId}`,
    lastUsed: Date.now(),
    policyKey: 'default|network:off',
    userId,
    conversationId
  });
  return state;
}

test('mudar as pastas do PC de um usuário NÃO derruba o sandbox de outro', async () => {
  _sessionsForTests.clear();
  const a = fakeSession('usuario-a', 'conversa-do-a-1');
  const b = fakeSession('usuario-b', 'conversa-do-b-1');
  const c = fakeSession('usuario-b', 'conversa-do-b-2');

  const destroyed = await destroySandboxesForUser('usuario-b');

  assert.equal(destroyed, 2, 'os dois sandboxes de B foram descartados');
  assert.equal(b.removed, true);
  assert.equal(c.removed, true);
  assert.equal(a.removed, false, 'o sandbox de A continua rodando');
  assert.ok(_sessionsForTests.has(sessionKey('usuario-a', 'conversa-do-a-1')));
  assert.ok(!_sessionsForTests.has(sessionKey('usuario-b', 'conversa-do-b-1')));
  _sessionsForTests.clear();
});

test('apagar a conversa de um usuário não toca no sandbox homônimo de outro', async () => {
  _sessionsForTests.clear();
  const a = fakeSession('usuario-a', CONV);
  const b = fakeSession('usuario-b', CONV);

  await destroyConversation(CONV, 'usuario-b');

  assert.equal(b.removed, true);
  assert.equal(a.removed, false);
  assert.ok(fs.existsSync(path.join(root, 'users', 'usuario-a', CONV)), 'o diretório de A permanece');
  assert.ok(!fs.existsSync(path.join(root, 'users', 'usuario-b', CONV)), 'o diretório de B foi removido');
  _sessionsForTests.clear();
});

// ---- Migração do layout legado --------------------------------------------

test('workspace legado é MIGRADO com os arquivos, não recriado vazio', () => {
  const legacyConv = 'conversa-legada-xyz';
  const legacyBase = path.join(root, legacyConv);
  fs.mkdirSync(path.join(legacyBase, 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(legacyBase, 'outputs', 'relatorio.xlsx'), 'planilha antiga');

  const ws = workspaceFor(legacyConv, 'usuario-legado');

  assert.equal(ws.base, path.join(root, 'users', 'usuario-legado', legacyConv));
  assert.equal(fs.readFileSync(path.join(ws.outputs, 'relatorio.xlsx'), 'utf8'), 'planilha antiga');
  assert.ok(!fs.existsSync(legacyBase), 'o diretório legado deixou de existir (foi movido)');
});

test('conflito na migração preserva o legado em vez de sobrescrever', () => {
  const conv = 'conversa-conflito-abc';
  fs.mkdirSync(path.join(root, 'users', 'dono', conv, 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'users', 'dono', conv, 'outputs', 'novo.txt'), 'novo');
  fs.mkdirSync(path.join(root, conv), { recursive: true });
  fs.writeFileSync(path.join(root, conv, 'antigo.txt'), 'antigo');

  const ws = workspaceFor(conv, 'dono');

  assert.equal(fs.readFileSync(path.join(ws.outputs, 'novo.txt'), 'utf8'), 'novo');
  assert.ok(fs.existsSync(path.join(root, conv, 'antigo.txt')), 'nada foi apagado no conflito');
});

// ---- Coleta de containers órfãos ------------------------------------------

test('a coleta de órfãos NUNCA seleciona containers de terceiros', () => {
  const nowMs = 1_000_000_000_000;
  const list = [
    { Id: 'externo', Labels: { 'com.example.app': 'outra-coisa' }, Created: (nowMs - 3600_000) / 1000 },
    { Id: 'sem-label', Labels: {}, Created: (nowMs - 3600_000) / 1000 },
    { Id: 'orfao-antigo', Labels: { [SANDBOX_LABEL_APP]: SANDBOX_APP_VALUE, [SANDBOX_LABEL_INSTANCE]: 'instancia-morta' }, Created: (nowMs - 3600_000) / 1000 },
    { Id: 'meu-ativo', Labels: { [SANDBOX_LABEL_APP]: SANDBOX_APP_VALUE, [SANDBOX_LABEL_INSTANCE]: 'eu' }, Created: (nowMs - 3600_000) / 1000 },
    { Id: 'meu-fora-do-mapa', Labels: { [SANDBOX_LABEL_APP]: SANDBOX_APP_VALUE, [SANDBOX_LABEL_INSTANCE]: 'eu' }, Created: (nowMs - 3600_000) / 1000 },
    { Id: 'meu-recem-criado', Labels: { [SANDBOX_LABEL_APP]: SANDBOX_APP_VALUE, [SANDBOX_LABEL_INSTANCE]: 'eu' }, Created: (nowMs - 5_000) / 1000 }
  ];

  const orphans = selectOrphanContainers(list, {
    known: new Set(['meu-ativo']),
    instanceId: 'eu',
    graceMs: 600_000,
    nowMs
  });

  assert.deepEqual(orphans.map(o => o.id).sort(), ['meu-fora-do-mapa', 'orfao-antigo']);
});

test('no boot (carência 0) todo container de instância anterior é órfão', () => {
  const nowMs = 1_000_000_000_000;
  const list = [
    { Id: 'sobrou-1', Labels: { [SANDBOX_LABEL_APP]: SANDBOX_APP_VALUE, [SANDBOX_LABEL_INSTANCE]: 'processo-morto' }, Created: (nowMs - 1000) / 1000 },
    { Id: 'de-terceiro', Labels: { 'org.opencontainers.image.title': 'postgres' }, Created: (nowMs - 1000) / 1000 }
  ];
  const orphans = selectOrphanContainers(list, { known: new Set(), instanceId: 'nova-instancia', graceMs: 0, nowMs });
  assert.deepEqual(orphans.map(o => o.id), ['sobrou-1']);
});

// ---- Política de reconciliação (Frente 7) ----

import { shouldReconcileOnBoot } from './sandbox.js';

test('reconciliação ligada por padrão fora de teste', () => {
  assert.equal(shouldReconcileOnBoot({ NODE_ENV: 'production' }), true);
  assert.equal(shouldReconcileOnBoot({ NODE_ENV: 'development' }), true);
  assert.equal(shouldReconcileOnBoot({}), true, 'sem NODE_ENV também liga');
});

test('reconciliação desligada por padrão em NODE_ENV=test', () => {
  assert.equal(shouldReconcileOnBoot({ NODE_ENV: 'test' }), false);
});

test('SANDBOX_RECONCILE_ON_BOOT=true força ligar em teste', () => {
  assert.equal(shouldReconcileOnBoot({ NODE_ENV: 'test', SANDBOX_RECONCILE_ON_BOOT: 'true' }), true);
});

test('SANDBOX_RECONCILE_ON_BOOT=false desliga em produção', () => {
  assert.equal(shouldReconcileOnBoot({ NODE_ENV: 'production', SANDBOX_RECONCILE_ON_BOOT: 'false' }), false);
});

test('SANDBOX_RECONCILE_ON_BOOT=true mantém ligado em produção', () => {
  assert.equal(shouldReconcileOnBoot({ NODE_ENV: 'production', SANDBOX_RECONCILE_ON_BOOT: 'true' }), true);
});
