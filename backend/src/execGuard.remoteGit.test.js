// Git REMOTO no sandbox é bloqueado; git LOCAL continua liberado.
//
// Por que: o token do GitHub nunca entra no sandbox (connectors/github.js), então
// `git push` pelo bash NÃO é um caminho que às vezes funciona — falha sempre. Sem
// este bloqueio, a falha chegava ao modelo como erro de rede genérico e ele
// insistia (outra tentativa, GIT_SSL_NO_VERIFY, abrir o github.com no navegador),
// queimando etapas num caminho que não existe.
// Roda com: node --test src/execGuard.remoteGit.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { BlockedExecutionError, guardCommand, guardPythonCode, remoteGitSubcommand } from './execGuard.js';

const bloqueia = (cmd) => assert.throws(() => guardCommand(cmd), BlockedExecutionError, `deveria bloquear: ${cmd}`);
const permite = (cmd) => assert.equal(guardCommand(cmd), true, `deveria permitir: ${cmd}`);

test('subcomandos remotos do git são detectados', () => {
  assert.equal(remoteGitSubcommand('git clone https://github.com/a/b.git'), 'clone');
  assert.equal(remoteGitSubcommand('git fetch origin'), 'fetch');
  assert.equal(remoteGitSubcommand('git pull --ff-only'), 'pull');
  assert.equal(remoteGitSubcommand('git push origin HEAD'), 'push');
  assert.equal(remoteGitSubcommand('git ls-remote origin'), 'ls-remote');
  assert.equal(remoteGitSubcommand('git remote add origin https://github.com/a/b.git'), 'remote add');
  assert.equal(remoteGitSubcommand('git remote set-url origin git@github.com:a/b.git'), 'remote set-url');
});

test('opções globais do git não escondem o subcomando', () => {
  assert.equal(remoteGitSubcommand('git -c http.sslVerify=false push origin main'), 'push');
  assert.equal(remoteGitSubcommand('git -C /workspace/repo/app pull'), 'pull');
  assert.equal(remoteGitSubcommand('git --no-pager fetch'), 'fetch');
  assert.equal(remoteGitSubcommand('/usr/bin/git clone https://github.com/a/b.git'), 'clone');
});

test('comando composto tem cada segmento analisado', () => {
  assert.equal(remoteGitSubcommand('cd /workspace/repo/app && git status && git push origin main'), 'push');
  assert.equal(remoteGitSubcommand('git add -A; git commit -m "ok"; git push'), 'push');
  assert.equal(remoteGitSubcommand('git log --oneline | head -5'), null);
});

test('git LOCAL não é confundido com remoto — nem pelo texto livre do commit', () => {
  assert.equal(remoteGitSubcommand('git status --porcelain'), null);
  assert.equal(remoteGitSubcommand('git diff --stat'), null);
  assert.equal(remoteGitSubcommand('git add -A'), null);
  assert.equal(remoteGitSubcommand('git commit -m "corrige o fetch dos dados e o push da fila"'), null);
  assert.equal(remoteGitSubcommand('git log --oneline -5'), null);
  assert.equal(remoteGitSubcommand('git branch -a'), null);
  assert.equal(remoteGitSubcommand('git rev-parse HEAD'), null);
  assert.equal(remoteGitSubcommand('git checkout -b feat/x'), null);
  assert.equal(remoteGitSubcommand('git config user.email a@b.com'), null);
  assert.equal(remoteGitSubcommand('git stash pop'), null);
  assert.equal(remoteGitSubcommand('git remote -v'), null);
  // Nem outro programa cujo nome contenha "git".
  assert.equal(remoteGitSubcommand('legit push'), null);
  assert.equal(remoteGitSubcommand('echo "git push" >> README.md'), null);
});

test('guardCommand bloqueia git remoto e aponta as ferramentas do backend', () => {
  for (const cmd of [
    'git clone https://github.com/fulano/app.git',
    'git push origin main',
    'cd /workspace/repo/app && git push -u origin feat/x',
    'GIT_SSL_NO_VERIFY=1 git fetch origin',
    'git pull'
  ]) bloqueia(cmd);

  try {
    guardCommand('git push origin main');
    assert.fail('deveria ter lançado');
  } catch (err) {
    assert.match(err.message, /github_clone, github_push ou github_create_pr/);
    assert.match(err.message, /conector seguro do backend/);
    assert.equal(err.blocked, true);
    // Nenhum segredo na mensagem.
    assert.doesNotMatch(err.message, /token|Bearer|x-access-token/i);
  }
});

test('guardCommand continua permitindo o git local do fluxo de trabalho', () => {
  for (const cmd of [
    'git status',
    'git diff --cached',
    'cd /workspace/repo/app && git add -A && git commit -m "Corrige o modo desenvolvedor"',
    'git log --oneline -20',
    'git rev-parse --abbrev-ref HEAD',
    'git checkout -b feat/dev-mode-ux-github'
  ]) permite(cmd);
});

test('a fuga pelo Python também passa pela guarda', () => {
  assert.throws(() => guardPythonCode('import os\nos.system("git push origin main")'), BlockedExecutionError);
  assert.throws(() => guardPythonCode('import subprocess\nsubprocess.run("git clone https://github.com/a/b.git")'), BlockedExecutionError);
  assert.equal(guardPythonCode('import subprocess\nsubprocess.run("git status")'), true);
});
