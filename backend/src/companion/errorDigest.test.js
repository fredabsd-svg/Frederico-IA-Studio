import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorDigest, signatureOf, looksLikeError } from './errorDigest.js';

test('signatureOf agrupa variações do mesmo erro (ts, números, ids, caminhos)', () => {
  const a = signatureOf('2026-07-23T10:00:01Z ERROR conexão recusada em /app/db.js:42 (id 9f3a2b1c8e7d)');
  const b = signatureOf('2026-07-23T11:59:59Z ERROR conexão recusada em /srv/db.js:87 (id aa11bb22cc33)');
  assert.equal(a, b);
});

test('looksLikeError distingue erro de log comum', () => {
  assert.ok(looksLikeError('ECONNREFUSED ao conectar no banco'));
  assert.ok(looksLikeError('Unhandled exception in worker'));
  assert.ok(!looksLikeError('Servidor iniciado na porta 3001'));
});

test('dispara alerta ao cruzar o limiar, apenas uma vez', () => {
  const d = new ErrorDigest({ threshold: 3, windowMs: 60_000 });
  const line = 'ERROR conexão recusada no host db';
  assert.equal(d.add([line], 1000).length, 0); // 1
  assert.equal(d.add([line], 2000).length, 0); // 2
  const fired = d.add([line], 3000);            // 3 -> dispara
  assert.equal(fired.length, 1);
  assert.equal(fired[0].count, 3);
  assert.equal(d.add([line], 4000).length, 0);  // já alertado: não repete
});

test('ocorrências fora da janela não contam para o limiar', () => {
  const d = new ErrorDigest({ threshold: 3, windowMs: 10_000 });
  const line = 'ERROR timeout na fila';
  d.add([line], 0);
  d.add([line], 1000);
  // 20s depois: as duas primeiras saíram da janela; esta é a única -> sem alerta
  assert.equal(d.add([line], 21_000).length, 0);
});

test('ignora linhas que não parecem erro', () => {
  const d = new ErrorDigest({ threshold: 2, windowMs: 60_000 });
  assert.equal(d.add(['tudo certo', 'requisição ok', 'health 200'], 1000).length, 0);
});

test('reset rearma a assinatura para poder alertar de novo', () => {
  const d = new ErrorDigest({ threshold: 2, windowMs: 60_000 });
  const line = 'FATAL panic no worker';
  d.add([line], 1000);
  const fired = d.add([line], 2000);
  assert.equal(fired.length, 1);
  d.reset(fired[0].signature);
  d.add([line], 3000);
  assert.equal(d.add([line], 4000).length, 1); // alertou de novo após reset
});
