// Handoff local ↔ worktree (Fase 24): funções puras + ciclo real (exportar e
// aplicar patch) contra um repositório git de verdade num workspace temporário.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'fred-handoff-'));
process.env.DB_PATH = ':memory:';

const {
  sanitizeRemoteUrl, repoFullNameFromRemote, worktreeDirFor, buildHandoffCommands,
  inspectPatch, exportPatch, applyPatch, handoffSnapshot, MAX_PATCH_CHARS
} = await import('./handoff.js');
const { workspaceFor } = await import('../sandbox.js');

// ---------------------------------------------------------------- puro

test('sanitizeRemoteUrl remove credencial embutida na URL', () => {
  assert.equal(sanitizeRemoteUrl('https://usuario:ghp_segredo@github.com/dono/repo.git'), 'https://github.com/dono/repo.git');
  assert.equal(sanitizeRemoteUrl('https://github.com/dono/repo.git'), 'https://github.com/dono/repo.git');
  assert.equal(sanitizeRemoteUrl('   '), null);
});

test('repoFullNameFromRemote entende https e ssh', () => {
  assert.equal(repoFullNameFromRemote('https://github.com/dono/repo.git'), 'dono/repo');
  assert.equal(repoFullNameFromRemote('git@github.com:dono/repo.git'), 'dono/repo');
  assert.equal(repoFullNameFromRemote('https://github.com/dono/repo'), 'dono/repo');
  assert.equal(repoFullNameFromRemote('https://gitlab.com/dono/repo.git'), null);
});

test('worktreeDirFor troca a barra da branch por hífen (senão viraria subpasta)', () => {
  assert.equal(worktreeDirFor('estudio', 'frederico/projeto-ab12cd34'), '../estudio-frederico-projeto-ab12cd34');
  assert.equal(worktreeDirFor('estudio', ''), '../estudio-tarefa');
});

test('branch publicada gera os comandos de worktree; não publicada, não', () => {
  const pub = buildHandoffCommands({ repoName: 'estudio', branch: 'frederico/x-1', published: true, dirty: 0 });
  assert.ok(pub.toLocal.some(c => c.command === 'git fetch origin frederico/x-1'));
  assert.ok(pub.toLocal.some(c => c.command.startsWith('git worktree add --track -b frederico/x-1 ../estudio-frederico-x-1 origin/')));
  assert.ok(pub.toLocal.some(c => c.command.startsWith('git worktree remove')));

  const solta = buildHandoffCommands({ repoName: 'estudio', branch: 'frederico/x-1', published: false, dirty: 0 });
  assert.equal(solta.toLocal.length, 0, 'sem branch publicada e sem sujeira não há o que levar');
});

test('trabalho não commitado sempre oferece o caminho do patch', () => {
  const cmds = buildHandoffCommands({ repoName: 'estudio', branch: 'frederico/x-1', published: false, dirty: 3, patchName: 'estudio.patch' });
  assert.ok(cmds.toLocal.some(c => c.command === 'git apply estudio.patch'));
});

test('o sentido de volta marca os arquivos novos antes do diff', () => {
  const { toWorktree } = buildHandoffCommands({ repoName: 'estudio', branch: 'main', published: true });
  // Sem `git add -N`, um arquivo criado localmente não entra no `git diff` e o
  // handoff perderia justamente o trabalho novo.
  assert.equal(toWorktree[0].command, 'git add -N .');
  assert.ok(toWorktree[1].command.includes('git diff HEAD --binary'));
});

test('nome de branch inválido não vira comando', () => {
  const cmds = buildHandoffCommands({ repoName: 'estudio', branch: '--force', published: true, dirty: 0 });
  assert.equal(cmds.toLocal.length, 0);
});

test('inspectPatch aceita um patch normal e lista os arquivos de destino', () => {
  const patch = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1 +1,2 @@',
    ' um',
    '+dois',
    ''
  ].join('\n');
  assert.deepEqual(inspectPatch(patch).files, ['src/app.js']);
});

test('inspectPatch entende arquivo novo (/dev/null de um lado)', () => {
  const patch = [
    'diff --git a/novo.txt b/novo.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/novo.txt',
    '@@ -0,0 +1 @@',
    '+oi',
    ''
  ].join('\n');
  assert.deepEqual(inspectPatch(patch).files, ['novo.txt']);
});

test('inspectPatch RECUSA caminho absoluto e travessia, nomeando o caminho', () => {
  const absoluto = 'diff --git a/x b/x\n--- /dev/null\n+++ /etc/passwd\n@@ -0,0 +1 @@\n+x\n';
  assert.match(inspectPatch(absoluto).error, /fora do repositório da tarefa: \/etc\/passwd/);

  const travessia = 'diff --git a/x b/x\n--- a/../../fora.txt\n+++ b/../../fora.txt\n@@ -1 +1 @@\n-a\n+b\n';
  assert.match(inspectPatch(travessia).error, /fora do repositório da tarefa/);
});

test('inspectPatch recusa texto que não é patch, vazio e grande demais', () => {
  assert.match(inspectPatch('').error, /vazio/);
  assert.match(inspectPatch('só um texto qualquer').error, /não parece um patch do git/);
  const gigante = `diff --git a/x b/x\n--- a/x\n+++ b/x\n${'+linha\n'.repeat(1)}`.padEnd(MAX_PATCH_CHARS + 10, 'x');
  assert.match(inspectPatch(gigante).error, /limite é/);
});

// ------------------------------------------------------------ git real

const USER = 'u-handoff';
const CONV = 'c-handoff';

function criarRepo() {
  const base = workspaceFor(CONV, USER).base;
  const dir = path.join(base, 'repo', 'estudio');
  fs.rmSync(path.join(base, 'repo'), { recursive: true, force: true }); // cada teste parte de um clone novo
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', `safe.directory=${dir}`, ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'teste@exemplo.com');
  git('config', 'user.name', 'Teste');
  fs.writeFileSync(path.join(dir, 'app.js'), 'um\ndois\ntres\n');
  git('add', '-A');
  git('commit', '-qm', 'inicial');
  return { dir, git };
}

test('exportPatch carrega arquivo MODIFICADO e arquivo NOVO (não rastreado)', async () => {
  const { dir } = criarRepo();
  fs.writeFileSync(path.join(dir, 'app.js'), 'um\ndois alterado\ntres\n');
  fs.writeFileSync(path.join(dir, 'novo.txt'), 'conteudo novo\n');

  const result = await exportPatch(USER, CONV, { repo: 'estudio' });
  assert.equal(result.error, undefined);
  assert.match(result.patch, /a\/app\.js/);
  // O ponto do índice temporário: sem ele, o arquivo novo ficaria de fora.
  assert.match(result.patch, /b\/novo\.txt/);
  assert.match(result.patch, /new file mode/);

  // E o índice de verdade do clone continua intocado (nada foi "staged").
  const staged = execFileSync('git', ['-c', `safe.directory=${dir}`, 'diff', '--cached', '--name-only'], { cwd: dir }).toString();
  assert.equal(staged.trim(), '');
});

test('exportPatch avisa quando não há nada para levar', async () => {
  criarRepo();
  const result = await exportPatch(USER, CONV, { repo: 'estudio' });
  assert.match(result.error, /está limpo/);
});

test('exportPatch recusa repositório que não é desta conversa', async () => {
  criarRepo();
  assert.match((await exportPatch(USER, CONV, { repo: 'outro' })).error, /não encontrado/);
  assert.match((await exportPatch(USER, CONV, { repo: '../../etc' })).error, /não encontrado/);
});

test('o ciclo completo fecha: o patch exportado se aplica de volta', async () => {
  const { dir } = criarRepo();
  fs.writeFileSync(path.join(dir, 'app.js'), 'um\ndois alterado\ntres\n');
  fs.writeFileSync(path.join(dir, 'novo.txt'), 'conteudo novo\n');
  const exported = await exportPatch(USER, CONV, { repo: 'estudio' });

  // Volta ao estado limpo e reaplica o patch — é o que acontece quando o
  // usuário leva o trabalho para o computador dele e devolve depois.
  execFileSync('git', ['-c', `safe.directory=${dir}`, 'checkout', '--', 'app.js'], { cwd: dir });
  fs.rmSync(path.join(dir, 'novo.txt'));

  const applied = await applyPatch(USER, CONV, { repo: 'estudio', patch: exported.patch });
  assert.equal(applied.error, undefined);
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'um\ndois alterado\ntres\n');
  assert.equal(fs.readFileSync(path.join(dir, 'novo.txt'), 'utf8'), 'conteudo novo\n');
});

test('patch que não casa com o estado atual é RECUSADO inteiro — nada é escrito', async () => {
  const { dir } = criarRepo();
  const patch = [
    'diff --git a/app.js b/app.js',
    '--- a/app.js',
    '+++ b/app.js',
    '@@ -1,3 +1,3 @@',
    ' conteudo que nao existe',
    '-outra coisa',
    '+substituto',
    ' fim',
    ''
  ].join('\n');
  const antes = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const result = await applyPatch(USER, CONV, { repo: 'estudio', patch });
  assert.match(result.error, /não se aplica ao estado atual/);
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), antes, 'o arquivo não pode ter sido tocado');
});

test('applyPatch recusa patch com caminho fora do repositório antes de chamar o git', async () => {
  criarRepo();
  const patch = 'diff --git a/x b/x\n--- /dev/null\n+++ /tmp/invadido.txt\n@@ -0,0 +1 @@\n+x\n';
  assert.match((await applyPatch(USER, CONV, { repo: 'estudio', patch })).error, /fora do repositório da tarefa/);
  assert.equal(fs.existsSync('/tmp/invadido.txt'), false);
});

test('handoffSnapshot relata branch, sujeira e branch não publicada', async () => {
  const { dir } = criarRepo();
  fs.writeFileSync(path.join(dir, 'app.js'), 'mudou\n');

  const { repos } = await handoffSnapshot(USER, CONV);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].name, 'estudio');
  assert.equal(repos[0].branch, 'main');
  assert.equal(repos[0].dirty, 1);
  // Sem remoto configurado, a branch não está publicada — e o painel precisa
  // dizer isso, em vez de oferecer um `git fetch` que falharia.
  assert.equal(repos[0].published, false);
  assert.equal(repos[0].remote, null);
  assert.ok(repos[0].commands.toLocal.some(c => c.command.startsWith('git apply')));
});

// O caso que perde trabalho se a base do patch for sempre HEAD: a branch está
// publicada, mas há commit local que o remoto não recebeu. A worktree traz só o
// publicado; se o patch partisse de HEAD, o commit do meio sumiria dos dois
// caminhos. Aqui o "remoto" é um clone local — o suficiente para haver
// `refs/remotes/origin/<branch>` de verdade.
test('com commit não publicado, o patch parte de origin/<branch> e carrega o commit', async () => {
  const { dir, git } = criarRepo();
  const remoto = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-handoff-remoto-'));
  execFileSync('git', ['init', '-q', '--bare', remoto]);
  git('remote', 'add', 'origin', remoto);
  git('push', '-q', 'origin', 'main');

  fs.writeFileSync(path.join(dir, 'app.js'), 'um\ndois commitado\ntres\n');
  git('add', '-A');
  git('commit', '-qm', 'trabalho que ainda nao foi publicado');
  fs.writeFileSync(path.join(dir, 'solto.txt'), 'nem commitado\n');

  const snapshot = await handoffSnapshot(USER, CONV);
  assert.equal(snapshot.repos[0].published, true);
  assert.equal(snapshot.repos[0].ahead, 1);
  assert.equal(snapshot.repos[0].patchAvailable, true);

  const result = await exportPatch(USER, CONV, { repo: 'estudio' });
  assert.equal(result.base, 'origin/main');
  assert.equal(result.commits, 1);
  assert.match(result.patch, /dois commitado/, 'o commit não publicado precisa estar no patch');
  assert.match(result.patch, /b\/solto\.txt/, 'e o trabalho não commitado também');

  fs.rmSync(remoto, { recursive: true, force: true });
});

test('handoffSnapshot devolve lista vazia sem repositório git', async () => {
  const { repos } = await handoffSnapshot('u-sem-repo', 'c-sem-repo');
  assert.deepEqual(repos, []);
});
