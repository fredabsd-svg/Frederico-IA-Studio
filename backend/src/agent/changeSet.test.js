// ChangeSet real (Fases 26–27): parsers puros + integração com um repositório
// git DE VERDADE criado num workspace temporário (git é dependência do backend
// — o mesmo binário do connectors/github.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'fred-changeset-'));
process.env.DB_PATH = ':memory:';

const { parseStatusPorcelain, parseNumstat, mergeChanges, collectConversationChanges } = await import('./changeSet.js');
const { workspaceFor } = await import('../sandbox.js');

test('parseStatusPorcelain classifica M/A/D/R e não rastreados', () => {
  const out = [
    ' M src/app.js',
    'A  src/novo.js',
    '?? solto.txt',
    ' D antigo.js',
    'R  velho.js -> novo-nome.js'
  ].join('\n');
  const files = parseStatusPorcelain(out);
  assert.deepEqual(files.map(f => f.status), ['M', 'A', 'A', 'D', 'R']);
  assert.equal(files[2].untracked, true);
  assert.equal(files[4].from, 'velho.js');
  assert.equal(files[4].path, 'novo-nome.js');
});

test('parseNumstat lê +/-, binários e renomeações', () => {
  const map = parseNumstat(['12\t4\tsrc/app.js', '-\t-\timg.png', '3\t0\tsrc/{a.js => b.js}'].join('\n'));
  assert.deepEqual(map.get('src/app.js'), { additions: 12, deletions: 4 });
  assert.deepEqual(map.get('img.png'), { additions: null, deletions: null });
  assert.deepEqual(map.get('src/b.js'), { additions: 3, deletions: 0 });
});

test('mergeChanges soma os totais sem contar binário/não rastreado como linhas', () => {
  const { files, totals } = mergeChanges(
    parseStatusPorcelain(' M a.js\n?? novo.txt'),
    parseNumstat('5\t2\ta.js')
  );
  assert.equal(files[0].additions, 5);
  assert.equal(files[1].additions, null, 'não rastreado não tem numstat — nada inventado');
  assert.deepEqual(totals, { files: 2, additions: 5, deletions: 2 });
});

test('collectConversationChanges lê um clone real e devolve a verdade do git', () => {
  const user = 'changeset-user';
  const conv = `changeset-conv-${Date.now()}`;
  const ws = workspaceFor(conv, user);
  const repoDir = path.join(ws.base, 'repo', 'meu-app');
  fs.mkdirSync(repoDir, { recursive: true });
  // Hermético: ignora config global/sistema do runner (que pode forçar
  // assinatura de commit, hooks etc.) — o teste só depende do git em si.
  const git = (...args) => execFileSync('git', ['-C', repoDir, '-c', 'commit.gpgsign=false', ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  });
  git('init', '-q', '-b', 'trabalho');
  git('config', 'user.email', 'teste@local');
  git('config', 'user.name', 'Teste');
  fs.writeFileSync(path.join(repoDir, 'a.js'), 'linha 1\nlinha 2\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repoDir, 'a.js'), 'linha 1\nlinha 2 editada\nlinha 3\n');
  fs.writeFileSync(path.join(repoDir, 'novo.txt'), 'novo\n');

  return collectConversationChanges(user, conv).then(({ repos }) => {
    assert.equal(repos.length, 1);
    const repo = repos[0];
    assert.equal(repo.name, 'meu-app');
    assert.equal(repo.branch, 'trabalho');
    const modified = repo.files.find(f => f.path === 'a.js');
    assert.equal(modified.status, 'M');
    assert.equal(modified.additions, 2);
    assert.equal(modified.deletions, 1);
    const untracked = repo.files.find(f => f.path === 'novo.txt');
    assert.equal(untracked.status, 'A');
    assert.equal(untracked.untracked, true);
    assert.equal(repo.totals.files, 2);
  });
});

test('workspace sem clone git devolve lista vazia (a UI cai no fallback)', async () => {
  const { repos } = await collectConversationChanges('changeset-user', `sem-repo-${Date.now()}`);
  assert.deepEqual(repos, []);
});
