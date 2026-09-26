// Esc fecha só a camada mais interna.
//
// Guarda o defeito do seletor de modelo dentro de um modal: a mesma tecla
// fechava a lista E o modal. A pilha consome o Esc quando há menu aberto e o
// deixa passar (para o modal) quando não há.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEscapeStack } from './escapeStack.js';

const tecla = key => {
  const ev = { key, prevented: false, stopped: false };
  ev.preventDefault = () => { ev.prevented = true; };
  ev.stopPropagation = () => { ev.stopped = true; };
  return ev;
};

test('sem camada aberta o Esc passa adiante (o modal pode fechar)', () => {
  const pilha = createEscapeStack();
  const ev = tecla('Escape');
  assert.equal(pilha.handle(ev), false);
  assert.equal(ev.stopped, false);
});

test('com menu aberto o Esc fecha só ele e não propaga', () => {
  const pilha = createEscapeStack();
  const fechados = [];
  pilha.push(() => fechados.push('menu'));
  const ev = tecla('Escape');
  assert.equal(pilha.handle(ev), true);
  assert.deepEqual(fechados, ['menu']);
  assert.equal(ev.stopped, true);
  assert.equal(ev.prevented, true);
});

test('camadas aninhadas fecham da mais interna para fora, uma por tecla', () => {
  const pilha = createEscapeStack();
  const fechados = [];
  const tiraPainel = pilha.push(() => { fechados.push('painel'); tiraPainel(); });
  const tiraFamilia = pilha.push(() => { fechados.push('familia'); tiraFamilia(); });
  pilha.handle(tecla('Escape'));
  assert.deepEqual(fechados, ['familia']);
  pilha.handle(tecla('Escape'));
  assert.deepEqual(fechados, ['familia', 'painel']);
  assert.equal(pilha.handle(tecla('Escape')), false);
});

test('outras teclas são ignoradas', () => {
  const pilha = createEscapeStack();
  let chamado = false;
  pilha.push(() => { chamado = true; });
  assert.equal(pilha.handle(tecla('Enter')), false);
  assert.equal(chamado, false);
});

test('retirar uma camada do meio preserva a ordem das outras', () => {
  const pilha = createEscapeStack();
  const fechados = [];
  pilha.push(() => fechados.push('a'));
  const tiraB = pilha.push(() => fechados.push('b'));
  tiraB();
  tiraB(); // idempotente
  assert.equal(pilha.size(), 1);
  pilha.handle(tecla('Escape'));
  assert.deepEqual(fechados, ['a']);
});
