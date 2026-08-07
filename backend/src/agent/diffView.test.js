// Diff por arquivo e reversão por hunk (Fase 27): parsers puros + ciclo real
// contra um repositório git de verdade num workspace temporário.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'fred-diffview-'));
process.env.DB_PATH = ':memory:';

const { parseHunks, buildHunkPatch, fileDiff, revertChange } = await import('./diffView.js');
const { workspaceFor } = await import('../sandbox.js');

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,4 @@',
  ' um',
  '+dois novo',
  ' tres',
  '-quatro',
  '@@ -10,2 +11,3 @@',
  ' dez',
  '+onze novo',
  ''
].join('\n');

test('parseHunks separa cabeçalho e hunks, com contagem e posição', () => {
  const { header, hunks } = parseHunks(DIFF);
  assert.ok(header.some(line => line.startsWith('diff --git')));
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].additions, 1);
  assert.equal(hunks[0].deletions, 1);
  assert.equal(hunks[0].oldStart, 1);
  assert.equal(hunks[1].newStart, 11);
  assert.equal(hunks[1].index, 1);
});

test('buildHunkPatch remonta um patch com UM hunk só, preservando o cabeçalho do arquivo', () => {
  const { header, hunks } = parseHunks(DIFF);
  const patch = buildHunkPatch(header, hunks[1]);
  assert.match(patch, /^diff --git a\/src\/app\.js/);
  assert.match(patch, /\+\+\+ b\/src\/app\.js/);
  assert.ok(patch.includes('@@ -10,2 +11,3 @@'));
  assert.ok(!patch.includes('dois novo'), 'o outro hunk não pode entrar no patch');
  assert.ok(patch.endsWith('\n'), 'patch precisa terminar em nova linha para o git aceitar');
  assert.equal(buildHunkPatch(header, null), '');
});

// ---- ciclo real com git -----------------------------------------------------

const USER = 'diffview-user';
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function seedRepo() {
  const conv = `diffview-conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repoDir = path.join(workspaceFor(conv, USER).base, 'repo', 'app');
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repoDir, '-c', 'commit.gpgsign=false', ...args], { env: gitEnv });
  git('init', '-q', '-b', 'trabalho');
  git('config', 'user.email', 'teste@local');
  git('config', 'user.name', 'Teste');
  const base = Array.from({ length: 20 }, (_, i) => `linha${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(repoDir, 'a.js'), base);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { conv, repoDir };
}

test('fileDiff devolve os hunks reais do arquivo alterado', async () => {
  const { conv, repoDir } = seedRepo();
  const linhas = fs.readFileSync(path.join(repoDir, 'a.js'), 'utf8').split('\n');
  linhas[1] = 'EDITADA';
  linhas[18] = 'NOVA FINAL';
  fs.writeFileSync(path.join(repoDir, 'a.js'), linhas.join('\n'));
  const diff = await fileDiff(USER, conv, { repo: 'app', file: 'a.js' });
  assert.equal(diff.error, undefined);
  assert.equal(diff.untracked, false);
  assert.ok(diff.hunks.length >= 1);
  assert.ok(diff.hunks.some(h => h.lines.some(l => l.startsWith('+') && l.includes('EDITADA'))));
});

test('arquivo NOVO aparece como adição, sem inventar diff do git', async () => {
  const { conv, repoDir } = seedRepo();
  fs.writeFileSync(path.join(repoDir, 'novo.txt'), 'a\nb\n');
  const diff = await fileDiff(USER, conv, { repo: 'app', file: 'novo.txt' });
  assert.equal(diff.untracked, true);
  assert.equal(diff.hunks.length, 1);
  assert.ok(diff.hunks[0].lines.every(l => l.startsWith('+')));
});

test('reverter o ARQUIVO inteiro volta ao estado do commit', async () => {
  const { conv, repoDir } = seedRepo();
  const alvo = path.join(repoDir, 'a.js');
  fs.writeFileSync(alvo, 'tudo diferente\n');
  const r = await revertChange(USER, conv, { repo: 'app', file: 'a.js' });
  assert.equal(r.ok, true);
  assert.equal(r.reverted, 'file');
  assert.equal(fs.readFileSync(alvo, 'utf8').startsWith('linha1'), true);
});

test('reverter arquivo NOVO o remove; hunk de arquivo novo é recusado com motivo', async () => {
  const { conv, repoDir } = seedRepo();
  const novo = path.join(repoDir, 'novo.txt');
  fs.writeFileSync(novo, 'x\n');
  assert.match((await revertChange(USER, conv, { repo: 'app', file: 'novo.txt', hunkIndex: 0 })).error, /não rastreado/);
  const r = await revertChange(USER, conv, { repo: 'app', file: 'novo.txt' });
  assert.equal(r.removed, true);
  assert.equal(fs.existsSync(novo), false);
});

test('reverter UM hunk desfaz só aquele trecho e preserva o resto', async () => {
  const { conv, repoDir } = seedRepo();
  const alvo = path.join(repoDir, 'a.js');
  // Duas alterações DISTANTES (linhas 2 e 19) → dois hunks separados.
  const linhas = fs.readFileSync(alvo, 'utf8').split('\n');
  linhas[1] = 'EDITADA-TOPO';
  linhas[18] = 'EDITADA-FIM';
  fs.writeFileSync(alvo, linhas.join('\n'));
  const antes = await fileDiff(USER, conv, { repo: 'app', file: 'a.js' });
  assert.equal(antes.hunks.length, 2, 'as duas edições precisam ser hunks separados');

  const r = await revertChange(USER, conv, { repo: 'app', file: 'a.js', hunkIndex: 0 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reverted, 'hunk');
  const conteudo = fs.readFileSync(alvo, 'utf8');
  assert.ok(conteudo.includes('linha2'), 'o trecho revertido voltou ao original');
  assert.ok(!conteudo.includes('EDITADA-TOPO'), 'a edição revertida sumiu');
  assert.ok(conteudo.includes('EDITADA-FIM'), 'a outra edição foi PRESERVADA');
});

test('hunk inexistente e caminho fora do repositório são recusados', async () => {
  const { conv, repoDir } = seedRepo();
  const editado = fs.readFileSync(path.join(repoDir, 'a.js'), 'utf8').replace('linha2', 'EDITADA');
  fs.writeFileSync(path.join(repoDir, 'a.js'), editado);
  assert.match((await revertChange(USER, conv, { repo: 'app', file: 'a.js', hunkIndex: 99 })).error, /não existe mais/);
  for (const file of ['../../../etc/passwd', '/etc/passwd', 'sub/../../fora.txt']) {
    const r = await revertChange(USER, conv, { repo: 'app', file });
    assert.match(r.error || '', /fora do repositório/, file);
  }
  assert.match((await fileDiff(USER, conv, { repo: '../outro', file: 'a.js' })).error, /fora do repositório/);
});
