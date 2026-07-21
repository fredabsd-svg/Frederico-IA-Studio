// Testes do watchdog de stream parado (streamGuard.js).
// Roda com: node --test src/agent/streamGuard.test.js
// Módulo puro (não importa `openai`), então roda em qualquer ambiente.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardStreamStall, StreamStalledError, STREAM_STALL_TIMEOUT_MS, PROVIDER_CONNECT_TIMEOUT_MS } from './streamGuard.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Stream de mentira: emite os chunks dados e depois (opcionalmente) trava
// para sempre, como um provedor que parou de mandar dados sem fechar a conexão.
function fakeStream(chunks, { hangAfter = false } = {}) {
  let i = 0;
  let returned = false;
  const it = {
    async next() {
      if (i < chunks.length) return { value: chunks[i++], done: false };
      if (hangAfter) return new Promise(() => {}); // pendura para sempre
      return { value: undefined, done: true };
    },
    async return() { returned = true; return { value: undefined, done: true }; },
    [Symbol.asyncIterator]() { return it; }
  };
  return { it, wasReturned: () => returned };
}

test('repassa todos os chunks e termina normalmente', async () => {
  const { it } = fakeStream(['a', 'b', 'c']);
  const got = [];
  for await (const chunk of guardStreamStall(it, { timeoutMs: 30000 })) got.push(chunk);
  assert.deepEqual(got, ['a', 'b', 'c']);
});

test('stream que para de emitir lança StreamStalledError e chama onStall', async () => {
  const { it } = fakeStream(['a'], { hangAfter: true });
  let stalled = false;
  const got = [];
  await assert.rejects(async () => {
    for await (const chunk of guardStreamStall(it, { timeoutMs: 50, onStall: () => { stalled = true; } })) got.push(chunk);
  }, (err) => err instanceof StreamStalledError && err.code === 'STREAM_STALLED');
  assert.deepEqual(got, ['a'], 'os chunks recebidos antes do stall são preservados');
  assert.equal(stalled, true, 'onStall deve ser chamado para abortar a requisição');
});

test('o timer não corre durante o processamento do chunk (só na espera)', async () => {
  const { it } = fakeStream(['a', 'b']);
  const got = [];
  for await (const chunk of guardStreamStall(it, { timeoutMs: 60 })) {
    got.push(chunk);
    await sleep(90); // corpo do loop demora mais que o timeout — não pode estourar
  }
  assert.deepEqual(got, ['a', 'b']);
});

test('break no consumidor fecha o stream subjacente (não vaza a conexão)', async () => {
  const { it, wasReturned } = fakeStream(['a', 'b', 'c']);
  for await (const chunk of guardStreamStall(it, { timeoutMs: 30000 })) {
    if (chunk === 'a') break;
  }
  await sleep(0); // o fechamento é fire-and-forget
  assert.equal(wasReturned(), true);
});

test('erro do próprio stream é propagado intacto (não vira stall)', async () => {
  const boom = new Error('erro do provedor');
  const it = {
    async next() { throw boom; },
    [Symbol.asyncIterator]() { return it; }
  };
  let stalled = false;
  await assert.rejects(async () => {
    for await (const _ of guardStreamStall(it, { timeoutMs: 30000, onStall: () => { stalled = true; } })) void _;
  }, (err) => err === boom);
  assert.equal(stalled, false);
});

test('limites configuráveis têm piso de 30s (contra config acidental agressiva)', () => {
  assert.ok(STREAM_STALL_TIMEOUT_MS >= 30000);
  assert.ok(PROVIDER_CONNECT_TIMEOUT_MS >= 30000);
});
