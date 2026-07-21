import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.WORKSPACE_ROOT = '/tmp/frederico-ssrf-tests';

const { isBlockedHost } = await import('./tools.js');

test('bloqueia loopback e faixas privadas IPv4', () => {
  for (const h of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '0.0.0.0']) {
    assert.equal(isBlockedHost(h), true, `deveria bloquear ${h}`);
  }
});

test('bloqueia metadados de nuvem e CGNAT', () => {
  assert.equal(isBlockedHost('169.254.169.254'), true);
  assert.equal(isBlockedHost('100.100.0.1'), true);
});

test('bloqueia multicast/reservado (224/4 e 240/4)', () => {
  assert.equal(isBlockedHost('224.0.0.1'), true);
  assert.equal(isBlockedHost('240.0.0.1'), true);
});

test('bloqueia nomes internos/loopback', () => {
  for (const h of ['localhost', 'db.local', 'svc.internal', 'x.localhost', '']) {
    assert.equal(isBlockedHost(h), true, `deveria bloquear ${h}`);
  }
});

test('IPv6 entre colchetes é normalizado antes de comparar (regressão do bypass)', () => {
  // Antes da correção, o hostname vinha como "[::1]" e escapava do filtro.
  assert.equal(isBlockedHost('[::1]'), true);
  assert.equal(isBlockedHost('::1'), true);
  assert.equal(isBlockedHost('[::]'), true);
});

test('IPv6 mapeado em IPv4 é resolvido e bloqueado (pontilhado e hexadecimal)', () => {
  assert.equal(isBlockedHost('[::ffff:127.0.0.1]'), true);
  // Forma que o parser WHATWG de fato produz a partir de ::ffff:127.0.0.1
  assert.equal(isBlockedHost('[::ffff:7f00:1]'), true);
  assert.equal(isBlockedHost('::ffff:192.168.0.1'), true);
});

test('IPv6 ULA e link-local são bloqueados em toda a faixa', () => {
  assert.equal(isBlockedHost('fc00::1'), true);
  assert.equal(isBlockedHost('fd12:3456::1'), true);
  assert.equal(isBlockedHost('fe80::1'), true);
  assert.equal(isBlockedHost('feaa::1'), true); // fe80::/10 vai até febf
});

test('endereços públicos continuam liberados', () => {
  for (const h of ['8.8.8.8', '1.1.1.1', 'exemplo.com', 'www.gov.br', 'brasilapi.com.br']) {
    assert.equal(isBlockedHost(h), false, `não deveria bloquear ${h}`);
  }
  // IPv6 público (Cloudflare)
  assert.equal(isBlockedHost('[2606:4700:4700::1111]'), false);
});
