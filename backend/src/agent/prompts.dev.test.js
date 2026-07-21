import assert from 'node:assert/strict';
import test from 'node:test';
import { developerContextFor, DEV_MODES, DEV_WRITE_MODES } from './prompts.js';

// Usamos sempre um projeto GitHub (sem projectId de pasta do PC), assim
// developerContextFor não toca no banco nem no sandbox — o teste fica isolado.
const gh = { repo: 'acme/app', branch: 'main' };
const ctx = (mode) => developerContextFor({ mode, github: gh, rules: '' }, 'user-1');

test('ignora requisições inválidas ou sem modo', () => {
  assert.equal(developerContextFor(null, 'u'), null);
  assert.equal(developerContextFor({ mode: 'inexistente' }, 'u'), null);
  assert.equal(developerContextFor({}, 'u'), null);
});

test('aceita os seis modos de trabalho', () => {
  assert.deepEqual(DEV_MODES, ['ask', 'plan', 'build', 'fix', 'review', 'auto']);
  for (const mode of DEV_MODES) {
    const c = ctx(mode);
    assert.ok(c, `modo ${mode} deveria produzir contexto`);
    assert.equal(c.mode, mode);
    assert.equal(typeof c.note, 'string');
    assert.ok(c.note.includes('MODO DESENVOLVEDOR ATIVO.'));
  }
});

test('apenas build/fix/auto podem escrever; ask/plan/review são leitura', () => {
  for (const mode of ['build', 'fix', 'auto']) {
    const c = ctx(mode);
    assert.equal(c.canWrite, true, `${mode} deveria poder escrever`);
    assert.equal(DEV_WRITE_MODES.has(mode), true);
    // Em projeto GitHub, escrever implica readOnlyProject=false.
    assert.equal(c.readOnlyProject, false, `${mode} não deveria ser somente leitura`);
  }
  for (const mode of ['ask', 'plan', 'review']) {
    const c = ctx(mode);
    assert.equal(c.canWrite, false, `${mode} não deveria poder escrever`);
    assert.equal(c.readOnlyProject, true, `${mode} deveria ser somente leitura`);
  }
});

test('modos de escrita exigem plano antes e resumo final', () => {
  for (const mode of ['build', 'fix', 'auto']) {
    const c = ctx(mode);
    assert.ok(/ANTES DE QUALQUER EDIÇÃO/.test(c.note), `${mode} deveria pedir plano antes`);
    assert.ok(/AO CONCLUIR/.test(c.note), `${mode} deveria pedir resumo final`);
  }
});

test('modos de leitura orientam a não alterar o repositório', () => {
  for (const mode of ['ask', 'plan', 'review']) {
    const c = ctx(mode);
    assert.ok(/NÃO altere/i.test(c.note), `${mode} deveria proibir alterações`);
  }
});

test('o modo corrigir erro orienta a causa raiz', () => {
  assert.ok(/CAUSA RAIZ/.test(ctx('fix').note));
});
