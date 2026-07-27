// Versionamento do Modo Design contra o banco de verdade.
//
// O que estes testes protegem não dá para verificar com função pura: a ordem
// das versões, a poda que não pode comer a versão em exibição, o isolamento
// entre contas e o token de preview como capacidade. Todos são casos em que um
// erro só apareceria com um usuário real e dados acumulados.
//
// Sem DATABASE_URL a suíte se pula sozinha (convenção do repositório); na CI de
// integração, com Postgres de pé, pular é falha.
import assert from 'node:assert/strict';
import test from 'node:test';

const { db, now } = await import('../db.js');

let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const store = await import('./store.js');

const stamp = Date.now();
const OWNER = `design-owner-${stamp}`;
const OTHER = `design-other-${stamp}`;

if (dbReady) {
  for (const id of [OWNER, OTHER]) {
    await db.prepare(
      'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    ).run(id, id, `${id}@design.test`, false, now(), now());
  }
}

async function newProject(userId = OWNER, outputType = 'web') {
  return store.createProject(userId, { title: `Projeto ${stamp}`, outputType });
}

test('projeto nasce com token de preview longo e sem versão atual', { skip: needsDb }, async () => {
  const project = await newProject();
  assert.ok(project.preview_token.length >= 32, 'o token é o que separa o artefato de quem tem a URL');
  assert.equal(project.current_version_id, null);
  assert.equal(await store.currentVersion(OWNER, project.id), undefined);
});

test('cada geração vira uma versão nova e a atual passa a ser ela', { skip: needsDb }, async () => {
  const project = await newProject();
  const v1 = await store.addVersion(OWNER, project.id, { content: '<html>1</html>', promptUsed: 'primeiro' });
  const v2 = await store.addVersion(OWNER, project.id, { content: '<html>2</html>', promptUsed: 'segundo' });
  assert.equal(v1.version_number, 1);
  assert.equal(v2.version_number, 2);
  const current = await store.currentVersion(OWNER, project.id);
  assert.equal(current.id, v2.id);
  const list = await store.listVersions(OWNER, project.id);
  assert.deepEqual(list.map(v => v.versionNumber), [2, 1], 'a mais recente primeiro');
});

test('reverter move o ponteiro sem apagar o que veio depois', { skip: needsDb }, async () => {
  const project = await newProject();
  const v1 = await store.addVersion(OWNER, project.id, { content: '<html>1</html>' });
  await store.addVersion(OWNER, project.id, { content: '<html>2</html>' });

  await store.setCurrentVersion(OWNER, project.id, v1.id);
  const current = await store.currentVersion(OWNER, project.id);
  assert.equal(current.id, v1.id);
  // A v2 continua no histórico: dá para ir e voltar.
  assert.equal((await store.listVersions(OWNER, project.id)).length, 2);

  // E de uma versão antiga a conversa segue: a próxima geração é a v3.
  const v3 = await store.addVersion(OWNER, project.id, { content: '<html>3</html>' });
  assert.equal(v3.version_number, 3);
});

test('reverter para versão de outro projeto (ou de outra conta) é recusado', { skip: needsDb }, async () => {
  const mine = await newProject();
  const theirs = await newProject(OTHER);
  const alheia = await store.addVersion(OTHER, theirs.id, { content: '<html>x</html>' });
  await store.addVersion(OWNER, mine.id, { content: '<html>meu</html>' });

  assert.equal(await store.setCurrentVersion(OWNER, mine.id, alheia.id), null);
  assert.equal(await store.setCurrentVersion(OWNER, theirs.id, alheia.id), null);
});

test('o histórico é podado no teto, mantendo as mais recentes', { skip: needsDb }, async () => {
  const project = await newProject();
  const extra = 4;
  for (let i = 0; i < store.MAX_VERSIONS + extra; i++) {
    await store.addVersion(OWNER, project.id, { content: `<html>${i}</html>` });
  }
  const versions = await store.listVersions(OWNER, project.id);
  assert.equal(versions.length, store.MAX_VERSIONS, 'o histórico não cresce sem teto');
  assert.equal(versions[0].versionNumber, store.MAX_VERSIONS + extra, 'a mais nova continua no topo');
  assert.equal(versions.at(-1).versionNumber, extra + 1, 'as mais antigas é que saem');
  const current = await store.currentVersion(OWNER, project.id);
  assert.equal(current.version_number, store.MAX_VERSIONS + extra);
});

test('a poda NUNCA remove a versão em exibição, mesmo sendo antiga', { skip: needsDb }, async () => {
  // Cenário direto da cláusula de proteção: o ponteiro aponta para uma versão
  // dentro da janela de descarte. Reverter faz o ponteiro voltar sem apagar o
  // que veio depois — se a poda ignorasse isso, o projeto ficaria sem nada para
  // renderizar e a prévia abriria em branco.
  const project = await newProject();
  const first = await store.addVersion(OWNER, project.id, { content: '<html>1</html>' });
  // Até o teto, nada é podado — é o estado antes de a janela alcançar a v1.
  for (let i = 1; i < store.MAX_VERSIONS; i++) {
    await store.addVersion(OWNER, project.id, { content: `<html>${i}</html>` });
  }
  // A versão que empurra a janela para cima entra por SQL: passar por
  // `addVersion` moveria o ponteiro para ela e o cenário deixaria de existir.
  const far = store.MAX_VERSIONS + 5;
  await db.prepare(
    'INSERT INTO design_versions (id,project_id,user_id,version_number,content,created_at) VALUES (?,?,?,?,?,?)'
  ).run(`far-${stamp}`, project.id, OWNER, far, '<html>futuro</html>', now());
  await store.setCurrentVersion(OWNER, project.id, first.id);

  await store.pruneVersions(project.id);

  const current = await store.currentVersion(OWNER, project.id);
  assert.equal(current?.id, first.id, 'a versão em exibição sobreviveu à poda');
});

test('projeto e versões de outra conta são invisíveis', { skip: needsDb }, async () => {
  const project = await newProject();
  const version = await store.addVersion(OWNER, project.id, { content: '<html>segredo</html>' });

  assert.equal(await store.getProject(OTHER, project.id), undefined);
  assert.equal(await store.getVersion(OTHER, project.id, version.id), undefined);
  assert.equal(await store.currentVersion(OTHER, project.id), undefined);
  assert.equal((await store.listVersions(OTHER, project.id)).length, 0);
  assert.ok(!(await store.listProjects(OTHER)).some(p => p.id === project.id));
});

test('o token de preview vale como capacidade e é regenerável', { skip: needsDb }, async () => {
  const project = await newProject();
  await store.addVersion(OWNER, project.id, { content: '<html>ok</html>' });

  // Sem escopo de usuário DE PROPÓSITO: a rota de preview não tem sessão.
  const found = await store.getProjectByToken(project.preview_token);
  assert.equal(found.id, project.id);
  const version = await store.currentVersionByProjectId(project.id);
  assert.match(version.content, /ok/);

  const rotated = await store.rotatePreviewToken(OWNER, project.id);
  assert.notEqual(rotated, project.preview_token);
  assert.equal(await store.getProjectByToken(project.preview_token), undefined, 'o token antigo morre');
  assert.equal((await store.getProjectByToken(rotated)).id, project.id);
  // Token de outra pessoa não rotaciona nada.
  assert.equal(await store.rotatePreviewToken(OTHER, project.id), null);
});

test('token curto nem chega ao banco', { skip: needsDb }, async () => {
  assert.equal(await store.getProjectByToken(''), null);
  assert.equal(await store.getProjectByToken('abc'), null);
});

test('apagar o projeto leva versões e mensagens junto', { skip: needsDb }, async () => {
  const project = await newProject();
  await store.addVersion(OWNER, project.id, { content: '<html>1</html>' });
  await store.addMessage(OWNER, project.id, 'user', 'faz aí');

  assert.equal(await store.deleteProject(OTHER, project.id), false, 'outra conta não apaga');
  assert.equal(await store.deleteProject(OWNER, project.id), true);
  assert.equal((await store.listVersions(OWNER, project.id)).length, 0);
  assert.equal((await store.listMessages(OWNER, project.id)).length, 0);
});

test('o chat do projeto guarda a ordem e o vínculo com a versão gerada', { skip: needsDb }, async () => {
  const project = await newProject();
  await store.addMessage(OWNER, project.id, 'user', 'crie uma landing');
  const version = await store.addVersion(OWNER, project.id, { content: '<html>1</html>' });
  await store.addMessage(OWNER, project.id, 'assistant', 'Versão 1 pronta.', version.id);

  const messages = await store.listMessages(OWNER, project.id);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(messages[1].versionId, version.id);
  assert.equal(messages[0].versionId, null);
});

test('design system: escopo por usuário na leitura, edição e remoção', { skip: needsDb }, async () => {
  const created = await store.createDesignSystem(OWNER, {
    name: 'Marca', primaryColor: '#123456', secondaryColor: null,
    fontHeading: 'Inter', fontBody: null, notes: null,
  });
  assert.equal(created.primaryColor, '#123456');
  assert.equal(await store.getDesignSystem(OTHER, created.id), null);
  assert.equal(await store.updateDesignSystem(OTHER, created.id, { name: 'Sequestrada' }), null);
  assert.equal(await store.deleteDesignSystem(OTHER, created.id), false);
  assert.equal(await store.deleteDesignSystem(OWNER, created.id), true);
});

test('projeto aponta para um design system apagado sem quebrar', { skip: needsDb }, async () => {
  const system = await store.createDesignSystem(OWNER, {
    name: 'Temporária', primaryColor: '#000000', secondaryColor: null, fontHeading: null, fontBody: null, notes: null,
  });
  const project = await store.createProject(OWNER, { title: 'Com marca', outputType: 'slides', designSystemId: system.id });
  await store.deleteDesignSystem(OWNER, system.id);
  // ON DELETE SET NULL: o projeto sobrevive à marca, só perde a referência.
  const reloaded = await store.getProject(OWNER, project.id);
  assert.equal(reloaded.design_system_id, null);
});
