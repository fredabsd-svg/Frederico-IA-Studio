// Regras do Smart Auto-scroll (chatScroll.js).
// Roda com: node --test src/chatScroll.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEAR_BOTTOM_THRESHOLD,
  chatContentKey,
  distanceFromBottom,
  followDecision,
  isNearBottom,
  keyPausesFollowing,
  scrollBehavior,
  shouldResumeFollowing,
  touchPausesFollowing,
  wheelPausesFollowing
} from './chatScroll.js';

// Elemento rolável falso: só os três números que importam.
const el = (scrollHeight, scrollTop, clientHeight) => ({ scrollHeight, scrollTop, clientHeight });

test('distância do fim é altura total menos rolagem menos janela', () => {
  assert.equal(distanceFromBottom(el(1000, 400, 500)), 100);
  assert.equal(distanceFromBottom(el(1000, 500, 500)), 0);
  assert.equal(distanceFromBottom(null), 0);
});

test('o limite de "perto do fim" fica entre 64 e 96 px', () => {
  assert.ok(NEAR_BOTTOM_THRESHOLD >= 64 && NEAR_BOTTOM_THRESHOLD <= 96);
  assert.equal(isNearBottom(el(1000, 500, 500)), true);
  assert.equal(isNearBottom(el(1000, 500 - NEAR_BOTTOM_THRESHOLD, 500)), true);
  assert.equal(isNearBottom(el(1000, 500 - NEAR_BOTTOM_THRESHOLD - 1, 500)), false);
  assert.equal(isNearBottom(el(2000, 0, 500)), false);
  // Sem elemento, considera no fim (evita acender o botão antes de montar).
  assert.equal(isNearBottom(null), true);
});

test('roda para cima pausa o acompanhamento; para baixo, não', () => {
  assert.equal(wheelPausesFollowing(-3), true);
  assert.equal(wheelPausesFollowing(-0.5), true);
  assert.equal(wheelPausesFollowing(3), false);
  assert.equal(wheelPausesFollowing(0), false);
});

test('PageUp, Home e seta para cima pausam; PageDown e End não', () => {
  assert.equal(keyPausesFollowing('ArrowUp'), true);
  assert.equal(keyPausesFollowing('PageUp'), true);
  assert.equal(keyPausesFollowing('Home'), true);
  assert.equal(keyPausesFollowing('PageDown'), false);
  assert.equal(keyPausesFollowing('End'), false);
  assert.equal(keyPausesFollowing('a'), false);
});

test('gesto de toque para cima (dedo descendo) pausa o acompanhamento', () => {
  assert.equal(touchPausesFollowing(100, 140), true);
  assert.equal(touchPausesFollowing(100, 102), false, 'um tremor de 2 px não é intenção');
  assert.equal(touchPausesFollowing(140, 100), false, 'dedo subindo desce o conteúdo — não pausa');
  assert.equal(touchPausesFollowing(NaN, 100), false);
});

// A REGRESSÃO que o teste de navegador encontrou: um gesto de roda para cima
// COMEÇA dentro dos 80 px finais. Se qualquer rolagem perto do fim religasse o
// seguimento, o primeiro quadro do gesto do próprio usuário desligaria a pausa
// que ele acabou de pedir — e o delta seguinte o traria de volta. Na prática, a
// roda para cima não saía do lugar durante o streaming.
test('depois de pausar, só uma rolagem PARA BAIXO até o fim retoma o acompanhamento', () => {
  // Subindo (movedDown = false) ainda dentro dos 80 px finais: NÃO retoma.
  assert.equal(shouldResumeFollowing({ atBottom: true, movedDown: false, pausedByUser: true }), false);
  // O usuário desceu de volta ao fim: retoma.
  assert.equal(shouldResumeFollowing({ atBottom: true, movedDown: true, pausedByUser: true }), true);
  // Longe do fim nunca retoma, em qualquer direção.
  assert.equal(shouldResumeFollowing({ atBottom: false, movedDown: true, pausedByUser: true }), false);
  assert.equal(shouldResumeFollowing({ atBottom: false, movedDown: false, pausedByUser: false }), false);
  // Sem pausa explícita, estar perto do fim basta (quem nunca saiu de lá).
  assert.equal(shouldResumeFollowing({ atBottom: true, movedDown: false, pausedByUser: false }), true);
  assert.equal(shouldResumeFollowing({}), false);
});

test('nova conversa vai ao fim; acompanhando, acompanha; pausado, só avisa', () => {
  assert.equal(followDecision({ conversationChanged: true, following: false, pausedByUser: true }), 'jump');
  assert.equal(followDecision({ following: true, pausedByUser: false }), 'follow');
  assert.equal(followDecision({ following: false, pausedByUser: true }), 'notify');
  // Pausado pelo usuário vence "following" ainda ligado por um render atrasado.
  assert.equal(followDecision({ following: true, pausedByUser: true }), 'notify');
});

test('streaming nunca usa animação suave; o clique explícito usa (salvo movimento reduzido)', () => {
  assert.equal(scrollBehavior({}), 'auto');
  assert.equal(scrollBehavior({ explicit: true }), 'smooth');
  assert.equal(scrollBehavior({ explicit: true, reducedMotion: true }), 'auto');
  assert.equal(scrollBehavior({ explicit: false, reducedMotion: false }), 'auto');
});

// ---- Chave de conteúdo -------------------------------------------------------

test('a chave muda quando o texto da última mensagem cresce (delta do streaming)', () => {
  const a = [{ id: 'm1', role: 'assistant', content: 'Ola' }];
  const b = [{ id: 'm1', role: 'assistant', content: 'Ola mundo' }];
  assert.notEqual(chatContentKey(a), chatContentKey(b));
});

test('a chave NÃO muda quando nada de conteúdo mudou (tique do relógio)', () => {
  const msgs = [{ id: 'm1', role: 'assistant', content: 'Ola', blocks: [{ type: 'text', content: 'Ola' }] }];
  // Mesmo conteúdo, array recriado: a chave tem de ser igual, senão o efeito
  // rodaria a cada segundo e brigaria com a rolagem do usuário.
  const clone = msgs.map(m => ({ ...m, blocks: m.blocks.map(b => ({ ...b })) }));
  assert.equal(chatContentKey(msgs), chatContentKey(clone));
});

test('a chave muda quando uma etapa de ferramenta avança ou produz saída', () => {
  const rodando = [{ id: 'm1', blocks: [{ type: 'tool', status: 'running', progress: { texto: 'ab' } }] }];
  const maisSaida = [{ id: 'm1', blocks: [{ type: 'tool', status: 'running', progress: { texto: 'abcd' } }] }];
  const concluida = [{ id: 'm1', blocks: [{ type: 'tool', status: 'done', progress: { texto: 'abcd' } }] }];
  assert.notEqual(chatContentKey(rodando), chatContentKey(maisSaida));
  assert.notEqual(chatContentKey(maisSaida), chatContentKey(concluida));
});

test('a chave muda com nova mensagem, com novo estado de execução e com pergunta pendente', () => {
  const base = [{ id: 'm1', content: 'a' }];
  assert.notEqual(chatContentKey(base), chatContentKey([...base, { id: 'm2', content: '' }]));
  assert.notEqual(
    chatContentKey([{ id: 'm1', content: 'a', execution: { state: 'tool_running', updatedAt: '1' } }]),
    chatContentKey([{ id: 'm1', content: 'a', execution: { state: 'awaiting_user', updatedAt: '2' } }])
  );
  assert.notEqual(
    chatContentKey([{ id: 'm1', content: 'a' }]),
    chatContentKey([{ id: 'm1', content: 'a', inputRequest: { id: 'iq_1' } }])
  );
});

test('lista vazia ou inválida não quebra a chave', () => {
  assert.equal(typeof chatContentKey([]), 'string');
  assert.equal(typeof chatContentKey(null), 'string');
  assert.equal(typeof chatContentKey(undefined), 'string');
});
