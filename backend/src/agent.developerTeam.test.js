import assert from 'node:assert/strict';
import test from 'node:test';

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/tmp/frederico-devteam-tests';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';

const { developerTeamContextFor, developerContextFor } = await import('./agent/prompts.js');

// Sem modo desenvolvedor, não há nota para os especialistas do Modo Equipe.
test('developerTeamContextFor devolve null sem modo desenvolvedor', () => {
  assert.equal(developerTeamContextFor(null, 'u'), null);
  assert.equal(developerTeamContextFor({}, 'u'), null);
  assert.equal(developerTeamContextFor({ mode: 'xpto' }, 'u'), null);
});

// Com repositório GitHub selecionado, a nota nomeia o repo/branch e proíbe o
// especialista de pedir o link ou dizer que não tem acesso ao GitHub — a causa
// do bug em que os modelos do debate respondiam "você não forneceu o link".
test('developerTeamContextFor ancora o parecer no repositório selecionado', () => {
  const note = developerTeamContextFor(
    { mode: 'build', github: { repo: 'fredabsd-svg/Frederico-IA-Studio', branch: 'main' } },
    'u'
  );
  assert.ok(note, 'esperava uma nota');
  assert.match(note, /fredabsd-svg\/Frederico-IA-Studio/);
  assert.match(note, /branch "main"/);
  assert.match(note, /MODO DESENVOLVEDOR ATIVO/);
  assert.match(note, /NÃO peça o link/i);
  assert.match(note, /não tem acesso ao GitHub/i);
});

// A nota do time NÃO deve mandar clonar nem dar passo a passo de ferramenta
// (isso é papel do executor, não dos especialistas que só analisam).
test('developerTeamContextFor não instrui o especialista a chamar ferramentas', () => {
  const note = developerTeamContextFor(
    { mode: 'plan', github: { repo: 'owner/repo' } },
    'u'
  );
  assert.doesNotMatch(note, /github_clone|github_push|PRIMEIRO PASSO OBRIGAT/i);
  // já a nota de EXECUÇÃO (outro caminho) segue mandando clonar:
  const execNote = developerContextFor({ mode: 'build', github: { repo: 'owner/repo' } }, 'u').note;
  assert.match(execNote, /github_clone/);
});
