import assert from 'node:assert/strict';
import test from 'node:test';
import { developerSessionForConversation, githubWritePermissionFor, newDevProject } from './useDevProjects.js';

// Regressão do bug "ao reabrir a conversa de dev o repositório some": a sessão de
// desenvolvedor (vínculo do repositório GitHub, modo e regras) precisa ser
// reconstruída a partir do projeto dono da conversa. Sem isto, o backend deixava
// de receber `developer.github` e o agente dizia que não encontrava o repositório.

const REPO_PROJECT = newDevProject({
  id: 'p_repo',
  name: 'SPED-HUB',
  mode: 'build',
  binding: { type: 'github', repo: 'fredabsd-svg/SPED-HUB', branch: 'main' },
  rules: 'Sempre rodar os testes.',
  conversationIds: ['conv-1', 'conv-2'],
});

test('reconstrói o vínculo do repositório GitHub ao reabrir a conversa', () => {
  const s = developerSessionForConversation([REPO_PROJECT], 'conv-1');
  assert.ok(s, 'deve encontrar a sessão');
  assert.deepEqual(s.github, { repo: 'fredabsd-svg/SPED-HUB', branch: 'main' });
  assert.equal(s.mode, 'build');
  assert.equal(s.devProjectId, 'p_repo');
  assert.equal(s.conversationId, 'conv-1');
  assert.match(s.rules, /Sempre rodar os testes/);
});

test('funciona para qualquer conversa vinculada ao projeto', () => {
  const s = developerSessionForConversation([REPO_PROJECT], 'conv-2');
  assert.equal(s.github.repo, 'fredabsd-svg/SPED-HUB');
});

test('conversa sem projeto dono devolve null (conversa comum)', () => {
  assert.equal(developerSessionForConversation([REPO_PROJECT], 'conv-desconhecida'), null);
  assert.equal(developerSessionForConversation([], 'conv-1'), null);
  assert.equal(developerSessionForConversation([REPO_PROJECT], ''), null);
});

test('vínculo de pasta do PC vira projectId, sem github', () => {
  const folder = newDevProject({
    id: 'p_folder', mode: 'fix',
    binding: { type: 'folder', folderId: 'fld_9' },
    conversationIds: ['c-folder'],
  });
  const s = developerSessionForConversation([folder], 'c-folder');
  assert.equal(s.github, null);
  assert.equal(s.projectId, 'fld_9');
  assert.equal(s.mode, 'fix');
});

test('projeto sem vínculo não produz github nem projectId', () => {
  const none = newDevProject({ id: 'p_none', binding: { type: 'none' }, conversationIds: ['c-none'] });
  const s = developerSessionForConversation([none], 'c-none');
  assert.equal(s.github, null);
  assert.equal(s.projectId, null);
  assert.equal(s.mode, 'plan'); // padrão quando o projeto não fixou um modo
});

// ── AUTORIZAÇÃO DE PUBLICAÇÃO NO GITHUB ─────────────────────────────────────
// A autorização é ESTRUTURADA e escopada: pertence a um repositório, a uma branch
// e a uma branch base. Ela sobrevive a turnos seguintes e ao reabrir a conversa —
// era isso que faltava quando o agente respondia "mesmo com sua autorização, as
// ferramentas não estão habilitadas nesta sessão".

const autorizado = (over = {}) => newDevProject({
  id: 'p_auth',
  mode: 'build',
  binding: { type: 'github', repo: 'fredabsd-svg/Frederico-IA-Studio', branch: 'feat/dev-mode-ux-github' },
  conversationIds: ['c-auth'],
  permissions: {
    githubWrite: true,
    githubWriteConfirmedAt: '2026-08-06T19:00:00.000Z',
    githubWriteScope: {
      repo: 'fredabsd-svg/Frederico-IA-Studio',
      branch: 'feat/dev-mode-ux-github',
      base: 'main',
      actions: ['push', 'create_pr']
    }
  },
  ...over
});

test('autorização válida para o vínculo atual viaja no payload', () => {
  const grant = githubWritePermissionFor(autorizado(), { base: 'main' });
  assert.equal(grant.githubWrite, true);
  assert.deepEqual(grant.githubWriteScope.actions, ['push', 'create_pr']);
  assert.equal(grant.githubWriteScope.repo, 'fredabsd-svg/Frederico-IA-Studio');
  assert.equal(grant.githubWriteScope.branch, 'feat/dev-mode-ux-github');
});

test('projeto sem autorização não manda permissão nenhuma', () => {
  assert.equal(githubWritePermissionFor(newDevProject({ binding: { type: 'github', repo: 'a/b', branch: 'main' } })), null);
  assert.equal(githubWritePermissionFor(null), null);
});

test('trocar a branch, o repositório ou o destino INVALIDA a autorização', () => {
  const outraBranch = autorizado({ binding: { type: 'github', repo: 'fredabsd-svg/Frederico-IA-Studio', branch: 'main' } });
  assert.equal(githubWritePermissionFor(outraBranch, { base: 'main' }), null);

  const outroRepo = autorizado({ binding: { type: 'github', repo: 'outro/projeto', branch: 'feat/dev-mode-ux-github' } });
  assert.equal(githubWritePermissionFor(outroRepo, { base: 'main' }), null);

  assert.equal(githubWritePermissionFor(autorizado(), { base: 'develop' }), null);
});

test('autorização não vale para vínculo de pasta do PC nem para projeto sem vínculo', () => {
  assert.equal(githubWritePermissionFor(autorizado({ binding: { type: 'folder', folderId: 'fld_1' } })), null);
  assert.equal(githubWritePermissionFor(autorizado({ binding: { type: 'none' } })), null);
});

test('ações desconhecidas são descartadas antes de sair do navegador', () => {
  const grant = githubWritePermissionFor(autorizado({
    permissions: {
      githubWrite: true,
      githubWriteConfirmedAt: '2026-08-06T19:00:00.000Z',
      githubWriteScope: {
        repo: 'fredabsd-svg/Frederico-IA-Studio',
        branch: 'feat/dev-mode-ux-github',
        base: 'main',
        actions: ['push', 'force_push', 'delete_branch']
      }
    }
  }), { base: 'main' });
  assert.deepEqual(grant.githubWriteScope.actions, ['push']);
});

test('reabrir a conversa preserva a autorização (a permissão não morre com o turno)', () => {
  const sessao = developerSessionForConversation([autorizado()], 'c-auth');
  assert.equal(sessao.permissions.githubWrite, true);
  assert.equal(sessao.permissions.githubWriteScope.branch, 'feat/dev-mode-ux-github');
});

test('reabrir a conversa de um projeto sem autorização não inventa permissão', () => {
  const sessao = developerSessionForConversation([REPO_PROJECT], 'conv-1');
  assert.equal(sessao.permissions, null);
});

test('projeto antigo (sem o campo permissions) carrega sem quebrar', () => {
  const antigo = { id: 'p_old', mode: 'build', binding: { type: 'github', repo: 'a/b', branch: 'main' }, conversationIds: ['c-old'] };
  const sessao = developerSessionForConversation([newDevProject(antigo)], 'c-old');
  assert.equal(sessao.permissions, null);
});
