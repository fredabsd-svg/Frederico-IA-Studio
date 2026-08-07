import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffState } from './handoffState.js';

test('branch publicada e nada pendente: a worktree traz tudo', () => {
  const state = handoffState({ branch: 'frederico/x-1', published: true, ahead: 0, dirty: 0, patchAvailable: false });
  assert.equal(state.kind, 'worktree');
  assert.equal(state.canWorktree, true);
  assert.equal(state.canPatch, false);
  assert.match(state.summary, /trabalho inteiro/);
});

test('branch não publicada com alterações: só o patch, e ele leva os arquivos novos', () => {
  const state = handoffState({ branch: 'frederico/x-1', published: false, ahead: null, dirty: 3, patchAvailable: true });
  assert.equal(state.kind, 'patch');
  assert.equal(state.canWorktree, false);
  assert.match(state.summary, /3 arquivos com alterações não commitadas/);
  assert.match(state.summary, /arquivos novos/);
});

// O caso que faz o usuário levar metade do trabalho sem perceber: dizer só
// "está publicada" esconderia o commit local e a alteração solta.
test('publicada COM pendência anuncia os dois caminhos e o que falta em cada um', () => {
  const state = handoffState({ branch: 'frederico/x-1', published: true, ahead: 2, dirty: 1, patchAvailable: true });
  assert.equal(state.kind, 'ambos');
  assert.equal(state.canWorktree, true);
  assert.equal(state.canPatch, true);
  assert.match(state.summary, /2 commits ainda não publicados/);
  assert.match(state.summary, /1 arquivo com alteração não commitada/);
  assert.match(state.summary, /use os dois/);
});

test('repositório limpo e não publicado diz que não há o que levar', () => {
  const state = handoffState({ branch: 'main', published: false, ahead: null, dirty: 0, patchAvailable: false });
  assert.equal(state.kind, 'nada');
  assert.match(state.summary, /está limpo/);
});

test('sem repositório não inventa caminho nenhum', () => {
  const state = handoffState(null);
  assert.equal(state.kind, 'nenhum');
  assert.equal(state.canWorktree, false);
  assert.equal(state.canPatch, false);
});

test('singular e plural saem certos (é texto que o usuário lê)', () => {
  const um = handoffState({ branch: 'b', published: true, ahead: 1, dirty: 0, patchAvailable: true });
  assert.match(um.summary, /1 commit ainda não publicado/);
  assert.doesNotMatch(um.summary, /1 commits/);
});
