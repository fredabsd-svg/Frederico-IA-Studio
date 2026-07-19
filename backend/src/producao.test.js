// Testes das lacunas da especificação de produção implementadas em
// sandbox.js: teto absoluto de vida do contêiner e modo de rede.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSandboxNetwork, sandboxExpired } from './sandbox.js';

test('rede do sandbox: só "none" bloqueia; qualquer outro valor mantém internet', () => {
  assert.equal(resolveSandboxNetwork('none'), 'none');
  assert.equal(resolveSandboxNetwork(' None '), 'none');
  assert.equal(resolveSandboxNetwork('NONE'), 'none');
  assert.equal(resolveSandboxNetwork('full'), 'full');
  assert.equal(resolveSandboxNetwork(''), 'full');
  assert.equal(resolveSandboxNetwork(undefined), 'full');
  assert.equal(resolveSandboxNetwork('qualquer-coisa'), 'full');
});

test('reaper: sandbox ocioso além do TTL é reciclado', () => {
  const nowMs = 1_000_000_000;
  const idle = 30 * 60 * 1000;
  const maxAge = 12 * 60 * 60 * 1000;
  const fresh = { lastUsed: nowMs - 1000, createdAt: nowMs - 1000 };
  const idleTooLong = { lastUsed: nowMs - idle - 1, createdAt: nowMs - idle - 1 };
  assert.equal(sandboxExpired(fresh, nowMs, idle, maxAge), false);
  assert.equal(sandboxExpired(idleTooLong, nowMs, idle, maxAge), true);
});

test('reaper: teto ABSOLUTO derruba sandbox velho mesmo em uso contínuo', () => {
  const nowMs = 1_000_000_000;
  const idle = 30 * 60 * 1000;
  const maxAge = 12 * 60 * 60 * 1000;
  // usado agora mesmo (não está ocioso), mas criado há mais de 12h
  const oldButBusy = { lastUsed: nowMs - 1000, createdAt: nowMs - maxAge - 1 };
  assert.equal(sandboxExpired(oldButBusy, nowMs, idle, maxAge), true);
});

test('reaper: maxAge = 0 desliga o teto absoluto', () => {
  const nowMs = 1_000_000_000;
  const idle = 30 * 60 * 1000;
  const veryOldButBusy = { lastUsed: nowMs - 1000, createdAt: 0 };
  assert.equal(sandboxExpired(veryOldButBusy, nowMs, idle, 0), false);
});

test('reaper: sessão antiga sem createdAt (criada antes do deploy) não quebra', () => {
  const nowMs = 1_000_000_000;
  const idle = 30 * 60 * 1000;
  const maxAge = 12 * 60 * 60 * 1000;
  const legacy = { lastUsed: nowMs - 1000 };
  assert.equal(sandboxExpired(legacy, nowMs, idle, maxAge), false);
});
