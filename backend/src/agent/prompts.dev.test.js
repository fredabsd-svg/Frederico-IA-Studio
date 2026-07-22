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

// Regressão do bug "conecto e diz que não tem acesso": com repo GitHub
// selecionado, a nota SÓ manda clonar quando a conexão está ativa.
test('repo GitHub conectado: manda clonar com github_clone', () => {
  const c = developerContextFor({ mode: 'build', github: gh, rules: '' }, 'user-1', { githubConnected: true });
  assert.ok(/PRIMEIRO PASSO OBRIGATÓRIO: chame a ferramenta github_clone/.test(c.note), 'deveria instruir o clone quando conectado');
  assert.ok(!/reconectar/i.test(c.note), 'não deveria pedir reconexão quando conectado');
});

test('repo GitHub SEM conexão: não manda clonar, pede reconexão e não dá "não tem acesso" genérico', () => {
  const c = developerContextFor({ mode: 'build', github: gh, rules: '' }, 'user-1', { githubConnected: false });
  assert.ok(!/PRIMEIRO PASSO OBRIGATÓRIO/.test(c.note), 'não deveria emitir o comando de clone sem conexão (a ferramenta nem é oferecida)');
  assert.ok(/NÃO estão disponíveis/.test(c.note), 'deveria dizer que as ferramentas do GitHub estão indisponíveis');
  assert.ok(/reconectar a conta do GitHub/i.test(c.note), 'deveria orientar a reconectar');
  assert.ok(/Configurações → Conectores/.test(c.note), 'deveria apontar o caminho da reconexão');
});

test('sem opts (chamadores existentes) mantém o comportamento de conectado', () => {
  // Default githubConnected=true preserva orchestrator/multiModel e o caminho antigo.
  assert.ok(/github_clone/.test(ctx('build').note));
});
