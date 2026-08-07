import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTECTED_CONTROL_SELECTORS,
  clampCompanionPosition,
  parseCompanionPosition,
  protectedBottomInset,
} from './companionPosition.js';

test('parseCompanionPosition rejeita posição incompleta, inválida ou corrompida', () => {
  assert.equal(parseCompanionPosition('{'), null);
  assert.equal(parseCompanionPosition({ x: 20 }), null);
  assert.equal(parseCompanionPosition({ x: null, y: null }), null);
  assert.equal(parseCompanionPosition({ x: Number.NaN, y: 20 }), null);
  assert.deepEqual(parseCompanionPosition('{"x":24,"y":36}'), { x: 24, y: 36 });
});

test('clampCompanionPosition traz o Nino de volta para dentro da tela', () => {
  assert.deepEqual(
    clampCompanionPosition({ x: 2400, y: 1200 }, { width: 1280, height: 720 }, { width: 82, height: 97 }),
    { x: 1190, y: 615 },
  );
  assert.deepEqual(
    clampCompanionPosition({ x: -200, y: -100 }, { width: 1280, height: 720 }, { width: 82, height: 97 }),
    { x: 8, y: 8 },
  );
});

test('clampCompanionPosition respeita a coluna lateral reservada', () => {
  assert.deepEqual(
    clampCompanionPosition(
      { x: 1800, y: 400 },
      { width: 1917, height: 857 },
      { width: 82, height: 97 },
      { right: 58 },
    ),
    { x: 1777, y: 400 },
  );
});

test('protectedBottomInset reserva da borda até o topo do controle mais alto', () => {
  // Compositor de 134px e terminal de 300px em uma janela de 857px: o controle
  // mais alto é o cabeçalho do terminal, em 423px.
  const composer = { top: 723, width: 900, height: 134 };
  const dockHead = { top: 423, width: 900, height: 38 };
  assert.equal(protectedBottomInset(857, [composer, dockHead]), 857 - 423 + 8);
  assert.equal(protectedBottomInset(857, [composer]), 857 - 723 + 8);
});

test('protectedBottomInset ignora medida ausente, oculta ou fora da janela', () => {
  assert.equal(protectedBottomInset(857, []), 8);
  assert.equal(protectedBottomInset(857, null), 8);
  assert.equal(protectedBottomInset(857, [null, { top: 400, width: 0, height: 0 }]), 8);
  assert.equal(protectedBottomInset(857, [{ top: Number.NaN, width: 10, height: 10 }]), 8);
  assert.equal(protectedBottomInset(857, [{ top: 900, width: 900, height: 38 }]), 8);
  assert.equal(protectedBottomInset(0, [{ top: 10, width: 900, height: 38 }]), 8);
});

test('protectedBottomInset não passa da altura da janela', () => {
  assert.equal(protectedBottomInset(857, [{ top: -200, width: 900, height: 400 }]), 857);
});

test('protectedBottomInset aceita outra margem de folga', () => {
  assert.equal(protectedBottomInset(800, [{ top: 700, width: 10, height: 40 }], 20), 120);
  assert.equal(protectedBottomInset(800, [], -5), 8);
});

// A regressão que motivou este arquivo: com o terminal aberto, um Nino arrastado
// para o rodapé pousava sobre o cabeçalho do terminal e engolia os cliques de
// recolher, expandir e maximizar (medido com navegador real, hit test em
// `e2e/tests/layout.spec.js`). O recuo inferior o para acima da faixa.
test('clampCompanionPosition mantém o Nino acima da faixa de controles', () => {
  const viewport = { width: 1917, height: 857 };
  const nino = { width: 82, height: 97 };
  const rects = [{ top: 723, width: 900, height: 134 }, { top: 423, width: 900, height: 38 }];
  const bottom = protectedBottomInset(viewport.height, rects);

  const arrastado = clampCompanionPosition({ x: 1700, y: 800 }, viewport, nino, { right: 22, bottom });
  assert.equal(arrastado.y + nino.height <= 423, true);
  assert.deepEqual(arrastado, { x: 1700, y: 318 });

  // Acima da faixa nada muda: arrastar para o meio da tela continua valendo.
  assert.deepEqual(
    clampCompanionPosition({ x: 300, y: 120 }, viewport, nino, { right: 22, bottom }),
    { x: 300, y: 120 },
  );
});

test('PROTECTED_CONTROL_SELECTORS cobre compositor, cabeçalho do terminal e "ir para o final"', () => {
  assert.deepEqual([...PROTECTED_CONTROL_SELECTORS], ['.composerWrap', '.dockHead', '.chatJump']);
});
