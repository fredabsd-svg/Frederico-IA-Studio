import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LAYOUT_LEVEL, environmentLabel, normalizeLayoutLevel,
  permissionsLabel, resolveLayout, sessionContextItems
} from './devWorkspaceLayout.js';

test('nível de layout desconhecido cai no padrão simples', () => {
  assert.equal(normalizeLayoutLevel('completo'), 'completo');
  assert.equal(normalizeLayoutLevel('simples'), 'simples');
  assert.equal(normalizeLayoutLevel('inventado'), DEFAULT_LAYOUT_LEVEL);
  assert.equal(normalizeLayoutLevel(null), 'simples');
});

test('simplicidade progressiva: simples recolhe as laterais, completo abre', () => {
  const simples = resolveLayout({ level: 'simples' });
  assert.equal(simples.leftCollapsed, true);
  assert.equal(simples.rightCollapsed, true);
  assert.deepEqual(simples.railTabs, ['atividade']);

  const completo = resolveLayout({ level: 'completo' });
  assert.equal(completo.leftCollapsed, false);
  assert.equal(completo.rightCollapsed, false);
  assert.deepEqual(completo.railTabs, ['atividade', 'arquivos', 'alteracoes', 'memoria']);
});

test('a escolha explícita do usuário vence o padrão do nível', () => {
  // Usuário abriu o rail direito estando no modo simples: a simplicidade
  // progressiva NÃO pode desfazer o clique dele.
  const r = resolveLayout({ level: 'simples', rightCollapsed: false });
  assert.equal(r.rightCollapsed, false);
  assert.equal(r.leftCollapsed, true, 'o que ele não tocou segue o padrão');
  // E o inverso: recolher no modo completo continua recolhido.
  assert.equal(resolveLayout({ level: 'completo', leftCollapsed: true }).leftCollapsed, true);
});

test('chat, plano e terminal existem nos dois níveis (é o mínimo de "o que está acontecendo")', () => {
  for (const level of ['simples', 'completo']) {
    const r = resolveLayout({ level });
    assert.equal(r.showTerminal, true, level);
    assert.equal(r.showPlan, true, level);
  }
});

test('environmentLabel diz a verdade sobre onde a tarefa roda', () => {
  assert.equal(environmentLabel({ github: { repo: 'a/b' } }), 'Repositório a/b');
  assert.equal(environmentLabel({ projectId: 'fld_1' }), 'Pasta do PC');
  assert.equal(environmentLabel({}), 'Sandbox da conversa');
  assert.equal(environmentLabel(null), null);
});

test('permissionsLabel resume o que foi concedido; sem nada, "somente leitura"', () => {
  assert.equal(permissionsLabel({}), 'somente leitura');
  assert.equal(permissionsLabel({ canWrite: true }), 'escrita no projeto');
  assert.equal(
    permissionsLabel({ canWrite: true, session: { permissions: { githubWrite: true, commandGrants: ['git clean*', 'git restore*'] } } }),
    'escrita no projeto · publicação · 2 comandos autorizados'
  );
  assert.equal(
    permissionsLabel({ session: { permissions: { commandGrants: ['git clean*'] } } }),
    '1 comando autorizado'
  );
});

test('a linha de contexto da sessão usa a branch REAL do pré-voo e explica a derivada', () => {
  const items = sessionContextItems({
    project: { name: 'Meu App' },
    session: { github: { repo: 'a/b', branch: 'main' }, permissions: { githubWrite: true } },
    model: 'openrouter::anthropic/claude-3.5',
    preflight: { branch: 'frederico/meu-app-abc123', workBranchDerived: true, boundBranch: 'main' },
    canWrite: true
  });
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  assert.equal(byKey.projeto.value, 'Meu App');
  assert.equal(byKey.branch.value, 'frederico/meu-app-abc123', 'a branch mostrada é a de trabalho, não a vinculada');
  assert.match(byKey.branch.note, /a partir de main/);
  assert.equal(byKey.ambiente.value, 'Repositório a/b');
  assert.equal(byKey.modelo.value, 'anthropic/claude-3.5', 'o prefixo de provedor sai da barra');
  assert.match(byKey.permissoes.value, /publicação/);
});

test('sem pré-voo, mostra a branch vinculada (o que se sabe com certeza) e omite o que não existe', () => {
  const items = sessionContextItems({ session: { github: { repo: 'a/b', branch: 'feature/x' } } });
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  assert.equal(byKey.branch.value, 'feature/x');
  assert.equal(byKey.branch.note, null);
  assert.equal(byKey.projeto, undefined, 'sem projeto, sem linha de projeto');
  assert.equal(byKey.modelo, undefined, 'sem modelo, sem linha de modelo');
  // Permissões sempre aparecem: "somente leitura" é informação, não vazio.
  assert.equal(byKey.permissoes.value, 'somente leitura');
});

test('sessão vazia ainda produz a linha de permissões, sem inventar o resto', () => {
  const items = sessionContextItems({});
  assert.deepEqual(items.map(i => i.key), ['permissoes']);
});
