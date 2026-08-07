import assert from 'node:assert/strict';
import test from 'node:test';
import { isProtectedBranch, resolveWorkBranch, slugify, workBranchNameFor, workBranchNote } from './workBranch.js';
import { isValidBranchName } from '../connectors/github.js';

test('slugify produz pedaço seguro para nome de branch', () => {
  assert.equal(slugify('Frederico IA Studio'), 'frederico-ia-studio');
  assert.equal(slugify('Migração & Ajustes!'), 'migracao-ajustes');
  assert.equal(slugify('   '), '');
  assert.ok(!slugify('a'.repeat(80)).includes(' '));
  assert.ok(slugify('a'.repeat(80)).length <= 32);
});

test('branches protegidas são reconhecidas, com ou sem caixa', () => {
  for (const name of ['main', 'MAIN', 'master', 'develop', 'prod']) assert.equal(isProtectedBranch(name), true, name);
  for (const name of ['feature/x', 'correcao-login', '']) assert.equal(isProtectedBranch(name), false, name);
});

test('nome da branch de trabalho é determinístico por conversa e válido para o git', () => {
  const a = workBranchNameFor({ projectName: 'Meu App', conversationId: 'conv_ABC12345' });
  const b = workBranchNameFor({ projectName: 'Meu App', conversationId: 'conv_ABC12345' });
  assert.equal(a, b, 'mesma conversa → mesma branch (retomada não cria branch nova)');
  assert.match(a, /^frederico\/meu-app-[a-z0-9]+$/);
  assert.equal(isValidBranchName(a), true, 'o validador do conector aceita o nome gerado');
  // Conversas diferentes no mesmo projeto não colidem.
  assert.notEqual(a, workBranchNameFor({ projectName: 'Meu App', conversationId: 'conv_XYZ98765' }));
  // Projeto sem nome ainda gera branch utilizável.
  assert.match(workBranchNameFor({ conversationId: 'c1' }), /^frederico\/tarefa-/);
});

test('modo somente-leitura nunca deriva branch', () => {
  const r = resolveWorkBranch({ boundBranch: 'main', canWrite: false, projectName: 'App', conversationId: 'c1' });
  assert.equal(r.derived, false);
  assert.equal(r.branch, 'main');
  assert.equal(r.reason, 'read_only');
});

test('branch de trabalho explícita no vínculo manda — a derivação não atropela', () => {
  const r = resolveWorkBranch({ boundBranch: 'feature/login', canWrite: true, projectName: 'App', conversationId: 'c1' });
  assert.equal(r.derived, false);
  assert.equal(r.branch, 'feature/login');
  assert.equal(r.reason, 'explicit_branch');
});

test('escrita sobre branch protegida deriva, com a protegida como base do PR', () => {
  const r = resolveWorkBranch({ boundBranch: 'main', canWrite: true, projectName: 'Meu App', conversationId: 'conv_ABC12345' });
  assert.equal(r.derived, true);
  assert.equal(r.base, 'main');
  assert.equal(r.reason, 'protected_branch');
  assert.match(r.branch, /^frederico\/meu-app-/);
  const nota = workBranchNote(r);
  assert.match(nota, /frederico\/meu-app-/);
  assert.match(nota, /base/);
  assert.match(nota, /nunca commite direto/i);
});

test('vínculo sem branch em modo de escrita também deriva (base fica a padrão do repo)', () => {
  const r = resolveWorkBranch({ boundBranch: '', canWrite: true, projectName: 'App', conversationId: 'c9' });
  assert.equal(r.derived, true);
  assert.equal(r.base, null);
  assert.equal(r.reason, 'no_branch_bound');
  assert.match(workBranchNote(r), /não fixou uma branch/i);
});

test('sem derivação não há nota (nada a explicar ao usuário)', () => {
  assert.equal(workBranchNote({ derived: false }), '');
  assert.equal(workBranchNote(null), '');
});
