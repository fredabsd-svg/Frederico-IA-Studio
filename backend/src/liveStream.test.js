import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLiveStream, getLiveStream, _resetLiveStreams } from './liveStream.js';

test('novo assinante recebe o replay do que já passou e depois os eventos ao vivo', () => {
  _resetLiveStreams();
  const s = openLiveStream('c1');
  s.publish({ type: 'status', content: 'Pensando...' });
  s.publish({ type: 'delta', content: 'Olá' });

  const got = [];
  const unsub = s.subscribe((rec) => got.push(rec.event));
  // Replay imediato dos 2 eventos anteriores.
  assert.deepEqual(got.map(e => e.content), ['Pensando...', 'Olá']);

  s.publish({ type: 'delta', content: ' mundo' });
  assert.equal(got[got.length - 1].content, ' mundo');
  unsub();
  s.publish({ type: 'done' });
  // Após cancelar a assinatura, não recebe mais nada.
  assert.equal(got.length, 3);
});

test('fromSeq evita reprocessar eventos já vistos', () => {
  _resetLiveStreams();
  const s = openLiveStream('c2');
  s.publish({ type: 'delta', content: 'a' }); // seq 1
  s.publish({ type: 'delta', content: 'b' }); // seq 2
  s.publish({ type: 'delta', content: 'c' }); // seq 3
  const got = [];
  s.subscribe((rec) => got.push(rec.seq), 2);
  assert.deepEqual(got, [3]);
});

test('getLiveStream devolve o stream ativo e null quando não há', () => {
  _resetLiveStreams();
  assert.equal(getLiveStream('nada'), null);
  const s = openLiveStream('c3');
  assert.equal(getLiveStream('c3'), s);
});

test('abrir um novo run substitui o stream anterior da mesma conversa', () => {
  _resetLiveStreams();
  const a = openLiveStream('c4');
  a.publish({ type: 'delta', content: 'antigo' });
  const b = openLiveStream('c4');
  assert.notEqual(a, b);
  assert.equal(getLiveStream('c4'), b);
  const got = [];
  b.subscribe((rec) => got.push(rec.event.content));
  // O buffer do run antigo não vaza para o novo.
  assert.deepEqual(got, []);
});

test('o buffer descarta os eventos mais antigos ao estourar o teto de eventos', () => {
  _resetLiveStreams();
  const s = openLiveStream('c5');
  const N = 5200; // acima do MAX_EVENTS (5000)
  for (let i = 0; i < N; i++) s.publish({ type: 'delta', content: String(i) });
  const got = [];
  s.subscribe((rec) => got.push(rec.event.content));
  // Mantém os mais recentes; o último sempre está presente.
  assert.equal(got[got.length - 1], String(N - 1));
  assert.ok(got.length <= 5000);
  // Os primeiríssimos foram descartados.
  assert.ok(!got.includes('0'));
});

test('finish agenda a limpeza sem segurar o event loop', () => {
  _resetLiveStreams();
  const s = openLiveStream('c6');
  s.publish({ type: 'done' });
  s.finish();
  assert.equal(s.done, true);
  // O stream ainda é recuperável durante a janela de carência (reconexão tardia).
  assert.equal(getLiveStream('c6'), s);
});
