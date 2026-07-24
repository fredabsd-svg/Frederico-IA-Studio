import assert from 'node:assert/strict';
import test from 'node:test';
import { developerSessionForConversation, newDevProject } from './useDevProjects.js';

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
