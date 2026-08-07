import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASKABLE_PATTERNS, DEFAULT_SHELL_POLICY, evaluateShellCommand,
  matchesCommandPattern, normalizeCommandGrants, splitShellCommand
} from './permissionPolicy.js';

test('padrões glob são ancorados e toleram espaços múltiplos', () => {
  assert.equal(matchesCommandPattern('git push*', 'git push origin main'), true);
  assert.equal(matchesCommandPattern('git push*', 'meu-git pushzao'), false);
  assert.equal(matchesCommandPattern('git reset --hard*', 'git  reset   --hard HEAD~1'), true);
  assert.equal(matchesCommandPattern('sudo *', 'sudo rm -rf /'), true);
  assert.equal(matchesCommandPattern('sudo *', 'echo sudo'), false);
});

test('comandos compostos lineares são divididos e vale a decisão mais restritiva', () => {
  assert.deepEqual(splitShellCommand('npm test && git clean -fd'), ['npm test', 'git clean -fd']);
  const result = evaluateShellCommand('npm test && git clean -fd');
  assert.equal(result.decision, 'ask');
  assert.equal(result.segment, 'git clean -fd');
  // deny vence ask
  assert.equal(evaluateShellCommand('git clean -fd; sudo reboot').decision, 'deny');
  // pipe também divide
  assert.equal(evaluateShellCommand('cat x | git restore .').decision, 'ask');
});

test('comandos comuns continuam liberados sem prompt (autonomia com portões)', () => {
  for (const cmd of ['npm test', 'git status', 'git diff', 'ls -la', 'rm arquivo.txt', 'git commit -m "x"', 'python script.py']) {
    assert.equal(evaluateShellCommand(cmd).decision, 'allow', `${cmd} deveria ser allow`);
  }
});

test('autorização do usuário rebaixa ask para allow, mas nunca um deny', () => {
  const grants = ['git clean*'];
  assert.equal(evaluateShellCommand('git clean -fd', { grants }).decision, 'allow');
  assert.equal(evaluateShellCommand('git reset --hard HEAD', { grants }).decision, 'ask');
  assert.equal(evaluateShellCommand('git push origin main', { grants: ['git push*'] }).decision, 'deny',
    'grant não pode liberar um deny — e um grant assim nem sobrevive à normalização');
});

test('normalizeCommandGrants é falha-fechada: só padrões ask da política', () => {
  const grants = normalizeCommandGrants({ commandGrants: [
    'git clean*',
    { pattern: 'git restore*' },
    'git push*',            // deny — não pode ser concedido
    'qualquer *',           // fora da política
    'git clean*'            // duplicado
  ] });
  assert.deepEqual(grants, ['git clean*', 'git restore*']);
  assert.deepEqual(normalizeCommandGrants(null), []);
  assert.deepEqual(normalizeCommandGrants({ commandGrants: 'git clean*' }), []);
});

test('a política padrão é coerente: catch-all primeiro, askable deriva dos ask', () => {
  assert.equal(DEFAULT_SHELL_POLICY[0].pattern, '*');
  assert.equal(DEFAULT_SHELL_POLICY[0].decision, 'allow');
  for (const pattern of ASKABLE_PATTERNS) {
    assert.equal(DEFAULT_SHELL_POLICY.find(rule => rule.pattern === pattern)?.decision, 'ask');
  }
  // toda regra tem motivo legível — é o texto que chega ao modelo e ao usuário
  for (const rule of DEFAULT_SHELL_POLICY) assert.ok(rule.reason?.length > 10);
});

test('comando vazio é allow (nada a avaliar) e segmentos vazios somem', () => {
  assert.equal(evaluateShellCommand('').decision, 'allow');
  assert.deepEqual(splitShellCommand(' && ; '), []);
});
