import assert from 'node:assert/strict';
import test from 'node:test';

// Configura ANTES do import: o módulo lê o env na carga.
process.env.FREE_TIER_CONCURRENCY = '1';
process.env.FREE_TIER_QUEUE_MAX = '2';

const { acquireFreeSlot, cancelFreeJob, freeQueueSnapshot, _resetFreeQueue } =
  await import('./freeQueue.js');

test('concorrência 1: o primeiro entra direto, o segundo espera a vaga', async () => {
  _resetFreeQueue();
  const release1 = await acquireFreeSlot({ id: 'a' });
  let secondStarted = false;
  const second = acquireFreeSlot({ id: 'b' }).then(release => { secondStarted = true; return release; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondStarted, false);
  assert.deepEqual(freeQueueSnapshot().waiting, 1);
  release1();
  const release2 = await second;
  assert.equal(secondStarted, true);
  release2();
  assert.equal(freeQueueSnapshot().running, 0);
});

test('posição na fila é informada e atualizada quando a fila anda', async () => {
  _resetFreeQueue();
  const release1 = await acquireFreeSlot({ id: 'a' });
  const positions = [];
  const second = acquireFreeSlot({ id: 'b', onPosition: (pos) => positions.push(pos) });
  const third = acquireFreeSlot({ id: 'c', onPosition: (pos) => positions.push(`c:${pos}`) });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(positions.includes(1));       // b entrou na posição 1
  assert.ok(positions.includes('c:2'));   // c entrou na posição 2
  release1();
  (await second)();
  (await third)();
});

test('cancelamento remove o job da fila e rejeita com FREE_QUEUE_CANCELLED', async () => {
  _resetFreeQueue();
  const release1 = await acquireFreeSlot({ id: 'a' });
  const waitingJob = acquireFreeSlot({ id: 'b' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelFreeJob('b'), true);
  await assert.rejects(waitingJob, err => err.code === 'FREE_QUEUE_CANCELLED');
  assert.equal(cancelFreeJob('b'), false); // já saiu — nada a cancelar
  release1();
});

test('fila cheia rejeita com FREE_QUEUE_FULL', async () => {
  _resetFreeQueue();
  const release1 = await acquireFreeSlot({ id: 'a' });
  const b = acquireFreeSlot({ id: 'b' });
  const c = acquireFreeSlot({ id: 'c' });
  await assert.rejects(acquireFreeSlot({ id: 'd' }), err => err.code === 'FREE_QUEUE_FULL');
  release1();
  (await b)();
  (await c)();
});

test('release é idempotente (chamar duas vezes não libera vaga fantasma)', async () => {
  _resetFreeQueue();
  const release1 = await acquireFreeSlot({ id: 'a' });
  release1();
  release1();
  assert.equal(freeQueueSnapshot().running, 0);
  const release2 = await acquireFreeSlot({ id: 'b' });
  assert.equal(freeQueueSnapshot().running, 1);
  release2();
});
