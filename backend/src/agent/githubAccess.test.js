// Pré-voo e inventário do conector GitHub.
//
// A REGRESSÃO EXATA que este arquivo guarda: o usuário autorizava a publicação,
// mas `github_push`/`github_create_pr` não entravam no inventário entregue ao
// modelo — e o agente respondia "mesmo com sua autorização, não consigo abrir o
// PR porque as ferramentas não estão habilitadas nesta sessão". A autorização
// vale para turnos seguintes porque é ESTRUTURADA e escopada, não uma regex
// aplicada ao texto do turno atual.
// Roda com: node --test src/agent/githubAccess.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_WRITE_ACTIONS,
  authorizationMatchesBinding,
  githubBlockingMessage,
  githubPreflight,
  githubPreflightNote,
  githubToolsForContext,
  normalizeGithubWriteAuthorization
} from './githubAccess.js';
import { toolAvailabilityNote } from './prompts.js';

const REPO = 'fredabsd-svg/Frederico-IA-Studio';
const BRANCH = 'feat/dev-mode-ux-github';

const devContext = (over = {}) => ({
  mode: 'build',
  canWrite: true,
  github: { repo: REPO, branch: BRANCH },
  ...over
});

const grant = (over = {}) => ({
  githubWrite: true,
  githubWriteConfirmedAt: '2026-08-06T19:00:00.000Z',
  githubWriteScope: { repo: REPO, branch: BRANCH, base: 'main', actions: [...GITHUB_WRITE_ACTIONS] },
  ...over
});

const nomes = (preflight) => githubToolsForContext(preflight).map(t => t.function.name).sort();

// ---- Normalização da autorização estruturada ---------------------------------

test('autorização válida é normalizada com repositório, branch, base e ações', () => {
  const auth = normalizeGithubWriteAuthorization(grant());
  assert.deepEqual(auth, {
    repo: REPO,
    branch: BRANCH,
    base: 'main',
    actions: ['push', 'create_pr'],
    confirmedAt: '2026-08-06T19:00:00.000Z'
  });
});

test('autorização sem githubWrite=true, sem repositório válido, sem branch ou sem ações é recusada', () => {
  assert.equal(normalizeGithubWriteAuthorization(null), null);
  assert.equal(normalizeGithubWriteAuthorization(grant({ githubWrite: false })), null);
  assert.equal(normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: 'repo-sem-owner', branch: BRANCH, actions: ['push'] } })), null);
  assert.equal(normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: REPO, actions: ['push'] } })), null);
  assert.equal(normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: REPO, branch: BRANCH, actions: [] } })), null);
});

test('ações desconhecidas são descartadas (o frontend não amplia o escopo)', () => {
  const auth = normalizeGithubWriteAuthorization(grant({
    githubWriteScope: { repo: REPO, branch: BRANCH, actions: ['push', 'force_push', 'delete_branch', 'merge'] }
  }));
  assert.deepEqual(auth.actions, ['push']);
});

test('campos desconhecidos na autorização são ignorados', () => {
  const auth = normalizeGithubWriteAuthorization({
    ...grant(),
    admin: true,
    githubWriteScope: { repo: REPO, branch: BRANCH, base: 'main', actions: ['push'], allRepos: true }
  });
  assert.deepEqual(Object.keys(auth).sort(), ['actions', 'base', 'branch', 'confirmedAt', 'repo']);
});

test('branch inválida (tentativa de injetar flag) é recusada', () => {
  assert.equal(normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: REPO, branch: '--force', actions: ['push'] } })), null);
  assert.equal(normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: REPO, branch: BRANCH, base: '--hard', actions: ['push'] } })), null);
});

test('a autorização pertence a um repositório, a uma branch e a uma base', () => {
  const auth = normalizeGithubWriteAuthorization(grant());
  assert.equal(authorizationMatchesBinding(auth, { repo: REPO, branch: BRANCH, base: 'main' }), true);
  assert.equal(authorizationMatchesBinding(auth, { repo: 'outro/projeto', branch: BRANCH, base: 'main' }), false);
  assert.equal(authorizationMatchesBinding(auth, { repo: REPO, branch: 'outra-branch', base: 'main' }), false);
  assert.equal(authorizationMatchesBinding(auth, { repo: REPO, branch: BRANCH, base: 'develop' }), false);
  // Sem branch no vínculo não há escopo — fail-closed.
  assert.equal(authorizationMatchesBinding(auth, { repo: REPO }), false);
});

// ---- Matriz do pré-voo -------------------------------------------------------

test('MATRIZ — GitHub desconectado: nenhuma ferramenta remota, causa informada', () => {
  const state = githubPreflight({ githubConnected: false, developerContext: devContext(), authorization: normalizeGithubWriteAuthorization(grant()) });
  assert.equal(state.blockingReason, 'github_not_connected');
  assert.equal(state.canRead, false);
  assert.deepEqual(nomes(state), []);
  assert.match(githubBlockingMessage(state.blockingReason), /Conectores/);
});

test('MATRIZ — conectado sem repositório vinculado: leitura sim, escrita não', () => {
  const state = githubPreflight({ githubConnected: true, developerContext: devContext({ github: null }), authorization: normalizeGithubWriteAuthorization(grant()) });
  assert.equal(state.blockingReason, 'repository_not_bound');
  assert.equal(state.canRead, true);
  assert.deepEqual(nomes(state), ['github_clone', 'github_list_repos']);
});

test('MATRIZ — modo somente leitura (plan/review/ask): sem escrita mesmo com autorização', () => {
  for (const mode of ['ask', 'plan', 'review']) {
    const state = githubPreflight({
      githubConnected: true,
      developerContext: devContext({ mode, canWrite: false }),
      authorization: normalizeGithubWriteAuthorization(grant())
    });
    assert.equal(state.blockingReason, 'read_only_mode', mode);
    assert.deepEqual(nomes(state), ['github_clone', 'github_list_repos'], mode);
  }
});

test('MATRIZ — modo gravável SEM autorização: clone liberado, publicação aguardando confirmação', () => {
  for (const mode of ['build', 'fix', 'auto']) {
    const state = githubPreflight({ githubConnected: true, developerContext: devContext({ mode }) });
    assert.equal(state.blockingReason, 'write_not_confirmed', mode);
    assert.equal(state.writeAuthorized, false, mode);
    assert.deepEqual(nomes(state), ['github_clone', 'github_list_repos'], mode);
    assert.match(githubBlockingMessage(state.blockingReason), /não foi autorizada/i);
  }
});

test('MATRIZ — modo gravável COM autorização estruturada: push e PR liberados', () => {
  const state = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant()),
    base: 'main'
  });
  assert.equal(state.blockingReason, null);
  assert.equal(state.writeAuthorized, true);
  assert.deepEqual(state.authorizedActions, ['push', 'create_pr']);
  assert.deepEqual(nomes(state), ['github_clone', 'github_create_pr', 'github_list_repos', 'github_push']);
});

test('REGRESSÃO — a autorização vale em turnos seguintes, sem o texto autorizar de novo', () => {
  // Turno 2+: `turnAuthorizesWrite` é false (o usuário não repetiu "pode abrir o
  // PR"), mas a autorização estruturada continua no payload. Antes desta frente,
  // este era o caso em que as ferramentas desapareciam do inventário.
  const state = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant()),
    turnAuthorizesWrite: false,
    base: 'main'
  });
  assert.equal(state.writeAuthorized, true);
  assert.ok(nomes(state).includes('github_push'));
  assert.ok(nomes(state).includes('github_create_pr'));
});

test('autorização de OUTRO repositório/branch/base não libera nada (escopo)', () => {
  const outroRepo = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: 'outro/projeto', branch: BRANCH, actions: ['push'] } }))
  });
  assert.equal(outroRepo.blockingReason, 'scope_mismatch');
  assert.deepEqual(nomes(outroRepo), ['github_clone', 'github_list_repos']);

  const outraBranch = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: REPO, branch: 'main', actions: ['push'] } }))
  });
  assert.equal(outraBranch.blockingReason, 'scope_mismatch');

  const outraBase = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: REPO, branch: BRANCH, base: 'develop', actions: ['push'] } })),
    base: 'main'
  });
  assert.equal(outraBase.blockingReason, 'scope_mismatch');
});

test('autorização só de push não libera abrir Pull Request', () => {
  const state = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: REPO, branch: BRANCH, base: 'main', actions: ['push'] } })),
    base: 'main'
  });
  assert.equal(state.writeAuthorized, true);
  assert.equal(state.tools.createPr, false);
  assert.deepEqual(nomes(state), ['github_clone', 'github_list_repos', 'github_push']);
});

test('SUB-AGENTE nunca publica, mesmo com autorização válida', () => {
  const state = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant()),
    isSubagent: true
  });
  assert.equal(state.blockingReason, 'subagent_not_allowed');
  assert.equal(state.writeAuthorized, false);
  assert.deepEqual(nomes(state), ['github_clone', 'github_list_repos']);
});

test('turno social (lowSignalTurn) não recebe ferramenta remota nenhuma', () => {
  const state = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant()),
    lowSignalTurn: true
  });
  assert.equal(state.blockingReason, 'low_signal_turn');
  assert.deepEqual(nomes(state), []);
});

test('o texto do turno autoriza, mas escopado ao vínculo (compatibilidade)', () => {
  const comBranch = githubPreflight({ githubConnected: true, developerContext: devContext(), turnAuthorizesWrite: true });
  assert.equal(comBranch.writeAuthorized, true);
  assert.deepEqual(comBranch.authorizedActions, ['push', 'create_pr']);

  // Sem branch no vínculo não há escopo: o texto não vira permissão global.
  const semBranch = githubPreflight({
    githubConnected: true,
    developerContext: devContext({ github: { repo: REPO, branch: '' } }),
    turnAuthorizesWrite: true
  });
  assert.equal(semBranch.writeAuthorized, false);
  assert.equal(semBranch.blockingReason, 'invalid_branch');
});

// ---- Nota entregue ao modelo -------------------------------------------------

test('a nota diz a CAUSA real do bloqueio e proíbe o contorno pelo bash', () => {
  const bloqueado = githubPreflight({ githubConnected: true, developerContext: devContext() });
  const note = githubPreflightNote(bloqueado);
  assert.match(note, /PUBLICAÇÃO NÃO AUTORIZADA/);
  assert.match(note, /não foi autorizada/i);
  assert.match(note, /AUTORIZAÇÃO\/ESTADO/);
  assert.match(note, /git push/);
  assert.doesNotMatch(note, /não existe no aplicativo\./);
});

test('autorizada, a nota nomeia as ferramentas e exige o link real do PR', () => {
  const liberado = githubPreflight({
    githubConnected: true,
    developerContext: devContext(),
    authorization: normalizeGithubWriteAuthorization(grant()),
    base: 'main'
  });
  const note = githubPreflightNote(liberado);
  assert.match(note, /PUBLICAÇÃO AUTORIZADA/);
  assert.match(note, /github_push e github_create_pr/);
  assert.match(note, new RegExp(BRANCH.replace(/\//g, '\\/')));
  assert.match(note, /DEPOIS que a ferramenta devolver a URL/);
});

test('sem conexão, sem repositório vinculado ou em turno social não há nota', () => {
  assert.equal(githubPreflightNote(githubPreflight({ githubConnected: false })), null);
  // Chat comum com GitHub conectado: nenhuma publicação em questão — avisar que
  // ela "não está autorizada" seria ruído.
  assert.equal(githubPreflightNote(githubPreflight({ githubConnected: true })), null);
  assert.equal(githubPreflightNote(githubPreflight({ githubConnected: true, developerContext: devContext({ github: null }) })), null);
  assert.equal(githubPreflightNote(githubPreflight({ githubConnected: true, developerContext: devContext(), lowSignalTurn: true })), null);
});

// ---- INVENTÁRIO ÚNICO --------------------------------------------------------
// O que o prompt ANUNCIA e o que o executor RECEBE saem do mesmo pré-voo. Este
// teste é a catraca: uma ferramenta não pode ser anunciada sem estar na lista, e
// nem estar na lista sem ser anunciada.

test('o inventário anunciado no prompt casa exatamente com as ferramentas liberadas', () => {
  const cenarios = [
    { nome: 'sem autorização', authorization: null },
    { nome: 'com autorização', authorization: normalizeGithubWriteAuthorization(grant()) },
    { nome: 'só push', authorization: normalizeGithubWriteAuthorization(grant({ githubWriteScope: { repo: REPO, branch: BRANCH, base: 'main', actions: ['push'] } })) }
  ];
  for (const { nome, authorization } of cenarios) {
    const state = githubPreflight({ githubConnected: true, developerContext: devContext(), authorization, base: 'main' });
    const tools = githubToolsForContext(state);
    const note = toolAvailabilityNote(tools, { githubNote: githubPreflightNote(state) });
    const liberadas = new Set(tools.map(t => t.function.name));
    for (const ferramenta of ['github_clone', 'github_push', 'github_create_pr', 'github_list_repos']) {
      const anunciada = note.includes(`- ${ferramenta}:`);
      assert.equal(anunciada, liberadas.has(ferramenta), `${nome}: ${ferramenta} anunciada=${anunciada} liberada=${liberadas.has(ferramenta)}`);
    }
  }
});
