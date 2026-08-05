// F-19: git local — operações reais de clone/push com servidor bare local.
//
// O backend usa `git clone https://github.com/...`, `git push`, etc.
// Este teste cria um repositório bare LOCAL e exercita o mesmo
// `git clone`/`push`/`checkout` que o connector usa — sem rede e sem
// precisar do GitHub. Serve como guarda contra regressões no ambiente
// (git ausente, permissões erradas, configuração de chaves) E como
// substrate para futuros testes de github_clone que substituem a URL
// fixa por uma file:// apontando para o bare local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverConfigGitFailure } from './connectors/github.js';

// Wrapper sobre git CLI. Devolve { code, stdout, stderr } para inspeção.
// Lança se o git não estiver disponível — é exatamente o que o
// `serverConfigGitFailure('git-missing')` do connector detecta.
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fred-git-'));
}

// Commit helper — git exige user.email/name configurados para commit.
function commitFile(cwd, message, file = 'README.md', content = 'hello') {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, ['add', file]);
  // Config local do repo (escopo do workdir, não global) — evita o erro
  // "Please tell me who you are" que o git devolve sem identity configurada.
  git(cwd, ['config', 'user.email', 'test@local']);
  git(cwd, ['config', 'user.name', 'Test']);
  return git(cwd, ['commit', '-m', message]);
}

test('git CLI está disponível e funciona (guarda de ambiente)', () => {
  // Se esta teste falhar, é o tipo de regressão que só aparece em produção:
  // git não está instalado (imagem sem git), ou PATH errado. Captura cedo.
  const r = git(os.tmpdir(), ['--version']);
  assert.equal(r.code, 0, `git --version falhou: ${r.stderr}`);
  assert.match(r.stdout, /^git version /);
});

test('clone bare → working, commit, push — ciclo completo', () => {
  // Simula exatamente o que github_clone + commits locais + github_push
  // fariam contra github.com. Aqui tudo é file:// para ser hermético.
  const sandbox = tmp();
  const origin = path.join(sandbox, 'origin.git');
  const workdir = path.join(sandbox, 'work');

  // Bare repo: o que o `github_clone` apontaria o remote `origin`.
  // `git init --bare -b main` (git ≥ 2.28) cria a branch padrão já nomeada
  // como `main` — sem isso o push inicial falha com "no upstream branch".
  assert.equal(git(sandbox, ['init', '--bare', '-b', 'main', origin]).code, 0);

  // Working repo inicial com um commit, simulando "repositório já existe
  // no GitHub". O working é criado, commit inicial é feito, e o push vai
  // para o bare — bare fica com a branch `main` populada.
  assert.equal(git(sandbox, ['clone', origin, workdir]).code, 0);
  // A config de identidade também é necessária no bare (para criar o
  // ref). Cobre o caso "bare sem config" que aparece em Docker minimal.
  git(origin, ['config', 'user.email', 'test@local']);
  git(origin, ['config', 'user.name', 'Test']);
  const first = commitFile(workdir, 'commit inicial');
  assert.equal(first.code, 0, `commit inicial falhou: ${first.stderr}`);
  const firstPush = git(workdir, ['push', 'origin', 'main']);
  assert.equal(firstPush.code, 0, `push inicial falhou: ${firstPush.stderr}`);

  // O backend faria: git clone file://... (já existe) → git checkout -b feat
  // → commit → push. Aqui simulamos o mesmo ciclo.
  const feature = 'feat-x';
  assert.equal(git(workdir, ['checkout', '-b', feature]).code, 0);
  const second = commitFile(workdir, 'adiciona feat', 'feat.txt', 'conteúdo da feat');
  assert.equal(second.code, 0);
  const push = git(workdir, ['push', '-u', 'origin', feature]);
  assert.equal(push.code, 0, `push da branch falhou: ${push.stderr}`);

  // Verifica que o bare tem a branch nova: este é o teste de que o push
  // funcionou de fato (não só retornou código 0).
  const branches = git(origin, ['branch', '-a']);
  assert.match(branches.stdout, new RegExp(`\\b${feature}\\b`),
    `branch ${feature} deveria existir no bare após o push; recebi: ${branches.stdout}`);

  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('clone de URL inválida devolve código de erro (o que serverConfigGitFailure usa)', () => {
  // Quando o git falha por causa NÃO-configurável (rede, auth, conflito),
  // ele devolve code != 0 com stderr descritivo. O connector distingue
  // "configuração" (tls, git-missing) de "outras falhas" via regex sobre
  // o stderr. Aqui verificamos que stderr é não-vazio quando o clone falha.
  const sandbox = tmp();
  const r = git(sandbox, ['clone', 'https://github.com/inexistente-xyz-12345/repo.git', 'dest']);
  assert.notEqual(r.code, 0, 'clone de URL inexistente deveria falhar');
  assert.ok(r.stderr.length > 0, 'stderr deveria ter detalhes da falha');
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('push sem remote configurado falha com mensagem clara', () => {
  // O connector usa `git push origin <branch>`. Sem o remote, o git devolve
  // erro de "no such remote" — não é tls nem git-missing, é config da
  // operação. serverConfigGitFailure devolve null (outra falha, tratada à parte).
  const sandbox = tmp();
  git(sandbox, ['init']);
  commitFile(sandbox, 'inicial');
  const r = git(sandbox, ['push', 'origin', 'main']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /origin|no such remote/i);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('serverConfigGitFailure distingue tls vs git-missing vs outras', () => {
  // Função PURA do connector que classifica falhas em CONFIGURAÇÃO ou OUTRAS.
  // Ela é o ponto que decide se vale a pena mostrar a NO_WORKAROUND_NOTE
  // ou seguir tentando.

  // CONFIGURAÇÃO — git não vai funcionar até alguém mexer no servidor.
  assert.equal(serverConfigGitFailure('SSL certificate problem: unable to get local issuer certificate'), 'tls');
  assert.equal(serverConfigGitFailure('server certificate verification failed'), 'tls');
  assert.equal(serverConfigGitFailure('fatal: não está instalado'), 'git-missing');
  assert.equal(serverConfigGitFailure('fork/exec /usr/bin/git: ENOENT'), 'git-missing');

  // OUTRAS — vale tentar de novo (rede oscilou, conflito, etc.).
  assert.equal(serverConfigGitFailure('fatal: could not resolve host github.com'), null);
  assert.equal(serverConfigGitFailure('rejected: non-fast-forward'), null);
  assert.equal(serverConfigGitFailure(''), null);
  assert.equal(serverConfigGitFailure(null), null);
  assert.equal(serverConfigGitFailure(undefined), null);
});
