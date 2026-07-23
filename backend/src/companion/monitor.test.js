import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGitStatus, proactiveAllowed } from './monitor.js';

test('parseGitStatus: workspace limpo com branch e tracking', () => {
  const s = parseGitStatus('## main...origin/main\n');
  assert.equal(s.isRepo, true);
  assert.equal(s.branch, 'main');
  assert.equal(s.dirty, false);
  assert.equal(s.changed.length, 0);
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
});

test('parseGitStatus: arquivos alterados e não rastreados', () => {
  const out = [
    '## feature/x...origin/feature/x [ahead 2]',
    ' M src/app.js',
    '?? novo.txt',
    'A  add.js',
  ].join('\n');
  const s = parseGitStatus(out);
  assert.equal(s.dirty, true);
  assert.deepEqual(s.changed, ['src/app.js', 'novo.txt', 'add.js']);
  assert.equal(s.ahead, 2);
  assert.equal(s.branch, 'feature/x');
});

test('parseGitStatus: detecta ahead e behind', () => {
  const s = parseGitStatus('## main...origin/main [ahead 1, behind 3]\n');
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 3);
});

test('parseGitStatus: fora de um repositório git', () => {
  const s = parseGitStatus('fatal: not a git repository (or any of the parent directories): .git');
  assert.equal(s.isRepo, false);
  assert.equal(s.dirty, false);
});

test('proactiveAllowed respeita enabled, modo e flag de alertas', () => {
  assert.ok(proactiveAllowed({ enabled: true, proactiveAlerts: true, mode: 'proativo' }));
  assert.ok(proactiveAllowed({ enabled: true, proactiveAlerts: true, mode: 'auxiliar' }));
  assert.ok(!proactiveAllowed({ enabled: true, proactiveAlerts: true, mode: 'silencioso' }));
  assert.ok(!proactiveAllowed({ enabled: true, proactiveAlerts: true, mode: 'foco' }));
  assert.ok(!proactiveAllowed({ enabled: false, proactiveAlerts: true, mode: 'proativo' }));
  assert.ok(!proactiveAllowed({ enabled: true, proactiveAlerts: false, mode: 'proativo' }));
});
