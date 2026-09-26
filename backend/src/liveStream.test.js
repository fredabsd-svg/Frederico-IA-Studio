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

test('cursor impossível (fromSeq além do último seq) no MESMO runId recebe o run inteiro', () => {
  // Cenário da RETOMADA: /resume reabre o stream com o MESMO runId do run
  // interrompido e o seq recomeça do 1. O cliente ainda guarda o cursor da
  // encarnação anterior (seq 5). Respeitar esse cursor pularia os primeiros
  // eventos da retomada; como nenhum cliente pode ter visto um seq que este
  // stream ainda não publicou, o cursor é descartado e o replay é completo.
  _resetLiveStreams();
  openLiveStream('c2b', 'R1');
  const r2 = openLiveStream('c2b', 'R1');
  r2.publish({ type: 'delta', content: 'r2-a' });
  r2.publish({ type: 'delta', content: 'r2-b' });
  const got = [];
  r2.subscribe((rec) => got.push(rec.event.content), { fromSeq: 5, runId: 'R1' });
  assert.deepEqual(got, ['r2-a', 'r2-b']);
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

test('runId ANTIGO na reconexão: o cliente recebe o run ATUAL desde o começo (replay + ao vivo)', () => {
  // Um run novo começou entre a desconexão e a reconexão. O cursor do run
  // antigo (fromSeq=7) não significa nada no run novo. A versão anterior
  // descartava o replay inteiro e deixava passar só os eventos AO VIVO, a
  // partir do meio — resposta remontada sem o começo.
  _resetLiveStreams();
  const s = openLiveStream('c2d', 'CORRENTE');
  s.publish({ type: 'delta', content: 'a' }); // seq 1
  s.publish({ type: 'delta', content: 'b' }); // seq 2
  const got = [];
  s.subscribe((rec) => got.push(`${rec.runId}:${rec.seq}:${rec.event.content}`), { fromSeq: 7, runId: 'ANTIGO' });
  assert.deepEqual(got, ['CORRENTE:1:a', 'CORRENTE:2:b']);
  s.publish({ type: 'delta', content: 'c' });
  assert.deepEqual(got, ['CORRENTE:1:a', 'CORRENTE:2:b', 'CORRENTE:3:c'], 'o ao vivo segue na ordem, sem buraco');
});

test('eventos AO VIVO passam pelo MESMO filtro do replay (fromSeq vale para os dois caminhos)', () => {
  // Regressão do defeito: o filtro só era aplicado ao replay; publish()
  // entregava tudo aos assinantes. Aqui o cursor está no seq 3 de um run com
  // só 3 eventos: os próximos (4, 5) chegam uma vez cada e em ordem.
  _resetLiveStreams();
  const s = openLiveStream('c2f', 'RUN');
  for (const c of ['1', '2', '3']) s.publish({ type: 'delta', content: c });
  const got = [];
  s.subscribe((rec) => got.push(rec.seq), { fromSeq: 3, runId: 'RUN' });
  assert.deepEqual(got, []);
  s.publish({ type: 'delta', content: '4' });
  s.publish({ type: 'done' });
  assert.deepEqual(got, [4, 5]);
});

test('término sem duplicidade: dois assinantes com cursores diferentes recebem cada seq uma vez', () => {
  _resetLiveStreams();
  const s = openLiveStream('c2g', 'RUN');
  s.publish({ type: 'delta', content: 'x' }); // 1
  s.publish({ type: 'delta', content: 'y' }); // 2
  const a = [];
  const b = [];
  s.subscribe((rec) => a.push(rec.seq), { fromSeq: 0, runId: 'RUN' });
  s.subscribe((rec) => b.push(rec.seq), { fromSeq: 1, runId: 'RUN' });
  s.publish({ type: 'done' }); // 3
  s.finish();
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [2, 3]);
});

test('isolamento entre conversas: assinar uma conversa não recebe eventos de outra', () => {
  _resetLiveStreams();
  const s1 = openLiveStream('conv-1', 'R');
  const s2 = openLiveStream('conv-2', 'R');
  const got = [];
  s1.subscribe((rec) => got.push(rec.event.content));
  s2.publish({ type: 'delta', content: 'da outra conversa' });
  s1.publish({ type: 'delta', content: 'desta conversa' });
  assert.deepEqual(got, ['desta conversa']);
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
