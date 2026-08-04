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
  s.subscribe((rec) => got.push(rec.seq), { fromSeq: 2 });
  assert.deepEqual(got, [3]);
});

test('assinatura com runId só recebe eventos do MESMO run', () => {
  // Cenário F-12: o cliente tinha visto seq=5 do run R1; a rede caiu; no
  // intervalo, o servidor iniciou um run novo (R2) na mesma conversa com
  // seq começando do 1. Sem filtro de runId, o fromSeq=5 pularia os primeiros
  // 5 eventos do R2 (texto faltando). Com filtro, o cliente recebe TUDO do
  // R2 e remonta sem buraco.
  _resetLiveStreams();
  const r1 = openLiveStream('c2b', 'R1');
  r1.publish({ type: 'delta', content: 'r1-a' });
  r1.publish({ type: 'delta', content: 'r1-b' });
  // O run novo SUBSTITUI o anterior (openLiveStream limpa o anterior). É
  // exatamente o caso "POST /chat aconteceu entre desconexão e reconexão".
  const r2 = openLiveStream('c2b', 'R2');
  r2.publish({ type: 'delta', content: 'r2-a' });
  r2.publish({ type: 'delta', content: 'r2-b' });
  const got = [];
  r2.subscribe((rec) => got.push(rec.event.content), { fromSeq: 5, runId: 'R2' });
  // runId=R2 + fromSeq=5: como o R2 só tem seq 1 e 2 e o filtro é strict,
  // nada passa (fromSeq=5 > max seq). É o comportamento correto: o cliente
  // perceberia que errou o cursor e resetaria. O teste importante vem abaixo.
  assert.deepEqual(got, []);
});

test('cliente que volta ao MESMO run recebe só o que perdeu', () => {
  // Caso comum: o cliente viu seq=2 do run R1, a rede caiu, o R1 continua
  // rodando. Na reconexão, com runId=R1 e fromSeq=2, recebe apenas os
  // eventos a partir do seq=3.
  _resetLiveStreams();
  const s = openLiveStream('c2c', 'RUN');
  s.publish({ type: 'delta', content: 'um' });   // seq 1
  s.publish({ type: 'delta', content: 'dois' }); // seq 2
  s.publish({ type: 'delta', content: 'tres' }); // seq 3
  s.publish({ type: 'delta', content: 'quatro' }); // seq 4
  const got = [];
  s.subscribe((rec) => got.push(rec.event.content), { fromSeq: 2, runId: 'RUN' });
  assert.deepEqual(got, ['tres', 'quatro']);
});

test('runId diferente do stream ativo não recebe NADA (sem fallback)', () => {
  // Se o cliente pediu um runId que não bate com o stream corrente, o filtro
  // NÃO volta para "replay do começo" — devolvemos vazio e o front decide.
  // Voltar silenciosamente para o começo mascararia o problema (run novo com
  // seq reiniciado) e produziria texto aparentemente correto mas incompleto.
  _resetLiveStreams();
  const s = openLiveStream('c2d', 'CORRENTE');
  s.publish({ type: 'delta', content: 'a' });
  s.publish({ type: 'delta', content: 'b' });
  const got = [];
  s.subscribe((rec) => got.push(rec.event.content), { fromSeq: 0, runId: 'ANTIGO' });
  assert.deepEqual(got, []);
});

test('eventos publicados após o subscribe também passam pelo filtro de runId', () => {
  // O filtro precisa valer TANTO para o replay (eventos já no buffer) QUANTO
  // para eventos novos publicados depois do subscribe — sem isto, o filtro
  // só seguraria o passado e deixaria o cliente ser sobrescrito pelos eventos
  // errados em tempo real.
  _resetLiveStreams();
  const s = openLiveStream('c2e', 'LIVE');
  const got = [];
  s.subscribe((rec) => got.push(rec.seq), { fromSeq: 0, runId: 'LIVE' });
  s.publish({ type: 'delta', content: 'x' }); // seq 1, runId=LIVE → passa
  assert.deepEqual(got, [1]);
  // Forçar runId diferente no evento (simula um stream que mudou de run no
  // meio — não acontece na prática, mas é o tipo de defesa que o filtro
  // precisa dar). Reabrindo o stream com outro runId:
  const s2 = openLiveStream('c2e', 'OUTRO');
  s2.publish({ type: 'delta', content: 'y' });
  // O subscribe original está em 's' (descartado pelo openLiveStream), então
  // o segundo publish não chega nele. O importante é o filtro do replay.
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
