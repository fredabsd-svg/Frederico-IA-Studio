// Decisão ÚNICA sobre as ferramentas do conector GitHub.
//
// O DEFEITO QUE ISTO CORRIGE: a liberação de `github_push`/`github_create_pr`
// dependia de uma condição espalhada no `loop.js` cujo único sinal de
// autorização era uma regex aplicada ao texto DESTE turno
// (`explicitlyAuthorizesGitWrite`). Consequência prática, vista em produção: o
// usuário autorizava numa mensagem ("pode abrir o PR"), o agente continuava a
// tarefa em turnos seguintes — ou retomava de um checkpoint — e as ferramentas
// de escrita simplesmente não estavam no inventário. O agente então respondia
// "mesmo com sua autorização verbal, não consigo abrir o PR porque as
// ferramentas não estão habilitadas nesta sessão", que é um defeito do
// aplicativo, não um limite do usuário.
//
// Duas coisas DIFERENTES passam a ser tratadas como diferentes:
//
//   autorização do usuário   ≠   disponibilidade técnica da ferramenta
//
// A autorização é ESTRUTURADA: pertence a um repositório, a uma branch, a uma
// branch base e a um conjunto de ações. Ela vem de ação explícita do usuário
// (botão "Autorizar publicação" no painel do projeto, ou a confirmação de um
// `ask_user`), viaja no payload `developer.permissions` e é RE-VALIDADA aqui —
// o frontend não amplia nada, o modelo não cria autorização nenhuma e um
// sub-agente nunca publica.
//
// A regex do texto do turno continua existindo como caminho secundário (o
// usuário que escreve "faça o commit e abra o PR" na própria missão não deve
// precisar de um segundo clique), mas ela também é ESCOPADA ao repositório e à
// branch do vínculo — nunca é permissão global.
import { githubToolDefinitions, GITHUB_WRITE_TOOLS, isValidBranchName, isValidRepoFullName } from '../connectors/github.js';

export const GITHUB_WRITE_ACTIONS = Object.freeze(['push', 'create_pr']);

// Motivos de bloqueio — a interface mostra a causa REAL, nunca um genérico
// "a ferramenta não está habilitada".
export const GITHUB_BLOCK_REASONS = Object.freeze({
  github_not_connected: 'O GitHub não está conectado nesta conta. Conecte em Configurações → Conectores.',
  repository_not_bound: 'Nenhum repositório GitHub está vinculado a este projeto.',
  read_only_mode: 'O modo de trabalho atual é somente leitura — escolha Implementar, Corrigir ou Autônomo para publicar.',
  write_not_confirmed: 'O GitHub está conectado, mas a publicação ainda não foi autorizada para esta branch.',
  invalid_branch: 'A branch informada na autorização não é um nome de branch válido.',
  scope_mismatch: 'A autorização registrada pertence a outro repositório, outra branch ou outra branch base.',
  action_not_authorized: 'As ações autorizadas não incluem publicar (push) e abrir Pull Request.',
  subagent_not_allowed: 'Sub-agentes não publicam: a publicação pertence ao agente principal da conversa.',
  low_signal_turn: 'Este turno é conversacional; nenhuma ferramenta remota foi oferecida.'
});

// Normaliza a autorização vinda do cliente. Campos desconhecidos são
// DESCARTADOS (o schema é a fronteira) e nada é aceito sem repositório válido.
export function normalizeGithubWriteAuthorization(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.githubWrite !== true) return null;
  const scope = raw.githubWriteScope && typeof raw.githubWriteScope === 'object' && !Array.isArray(raw.githubWriteScope)
    ? raw.githubWriteScope
    : {};
  const repo = String(scope.repo || '').trim();
  if (!isValidRepoFullName(repo)) return null;
  const branch = String(scope.branch || '').trim();
  if (!branch || !isValidBranchName(branch)) return null;
  const base = String(scope.base || '').trim();
  if (base && !isValidBranchName(base)) return null;
  const actions = Array.isArray(scope.actions)
    ? [...new Set(scope.actions.map(a => String(a || '').trim()).filter(a => GITHUB_WRITE_ACTIONS.includes(a)))]
    : [];
  if (!actions.length) return null;
  const confirmedAt = String(raw.githubWriteConfirmedAt || '').trim();
  return {
    repo,
    branch,
    base: base || null,
    actions,
    confirmedAt: confirmedAt && !Number.isNaN(Date.parse(confirmedAt)) ? confirmedAt : null
  };
}

// A autorização estruturada vale para ESTE vínculo? Repositório e branch têm de
// bater; a base, quando declarada nos dois lados, também.
export function authorizationMatchesBinding(authorization, binding) {
  if (!authorization || !binding?.repo) return false;
  if (authorization.repo.toLowerCase() !== String(binding.repo).toLowerCase()) return false;
  // Vínculo sem branch = trabalho na branch padrão do repositório: a
  // autorização precisa nomear a branch, e aí não há como conferir a igualdade.
  // Fail-closed: exigimos que o vínculo declare a branch.
  if (!binding.branch) return false;
  if (authorization.branch !== String(binding.branch)) return false;
  if (authorization.base && binding.base && authorization.base !== String(binding.base)) return false;
  return true;
}

// Estado REAL da integração para esta execução. É o que a interface mostra e o
// que decide o inventário — as duas coisas saem da MESMA função, para o painel
// nunca dizer "pode enviar" quando o executor não recebeu a ferramenta.
export function githubPreflight({
  githubConnected = false,
  developerContext = null,
  authorization = null,
  turnAuthorizesWrite = false,
  base = null,
  lowSignalTurn = false,
  isSubagent = false
} = {}) {
  const binding = developerContext?.github || null;
  const state = {
    connected: Boolean(githubConnected),
    repository: binding?.repo || null,
    branch: binding?.branch || null,
    base: base || null,
    mode: developerContext?.mode || null,
    canRead: false,
    canWrite: Boolean(developerContext?.canWrite),
    writeAuthorized: false,
    authorizedActions: [],
    tools: { clone: false, push: false, createPr: false },
    blockingReason: null
  };

  if (lowSignalTurn) { state.blockingReason = 'low_signal_turn'; return state; }
  if (!state.connected) { state.blockingReason = 'github_not_connected'; return state; }

  // Leitura (clone/list_repos) depende apenas da conexão — inclusive fora do
  // Modo Desenvolvedor, que é o comportamento que já existia.
  state.canRead = true;
  state.tools.clone = true;

  if (isSubagent) { state.blockingReason = 'subagent_not_allowed'; return state; }
  if (!binding?.repo) { state.blockingReason = 'repository_not_bound'; return state; }
  if (!state.canWrite) { state.blockingReason = 'read_only_mode'; return state; }

  // Caminho 1 — autorização ESTRUTURADA, escopada a repo/branch/base/ações.
  if (authorization) {
    const bindingScope = { repo: binding.repo, branch: binding.branch, base: base || null };
    if (!authorizationMatchesBinding(authorization, bindingScope)) {
      state.blockingReason = 'scope_mismatch';
      return state;
    }
    const actions = authorization.actions.filter(a => GITHUB_WRITE_ACTIONS.includes(a));
    if (!actions.length) { state.blockingReason = 'action_not_authorized'; return state; }
    state.writeAuthorized = true;
    state.authorizedActions = actions;
    state.tools.push = actions.includes('push');
    state.tools.createPr = actions.includes('create_pr');
    state.base = authorization.base || state.base;
    return state;
  }

  // Caminho 2 — o pedido DESTE turno já autoriza em palavras ("faça o commit e
  // abra o PR"). Vale só para o vínculo atual, e a branch precisa existir no
  // vínculo: sem branch declarada não há escopo, e sem escopo não há permissão.
  if (turnAuthorizesWrite) {
    if (!binding.branch || !isValidBranchName(binding.branch)) {
      state.blockingReason = 'invalid_branch';
      return state;
    }
    state.writeAuthorized = true;
    state.authorizedActions = [...GITHUB_WRITE_ACTIONS];
    state.tools.push = true;
    state.tools.createPr = true;
    return state;
  }

  state.blockingReason = 'write_not_confirmed';
  return state;
}

// Inventário de ferramentas github_* derivado do pré-voo. NÃO existe segunda
// decisão em outro lugar: quem oferece a ferramenta e quem informa a interface
// leem a mesma coisa.
export function githubToolsForContext(preflight) {
  if (!preflight?.connected || !preflight.canRead) return [];
  return githubToolDefinitions.filter(tool => {
    const name = tool.function.name;
    if (!GITHUB_WRITE_TOOLS.has(name)) return true;
    if (name === 'github_push') return preflight.tools.push === true;
    if (name === 'github_create_pr') return preflight.tools.createPr === true;
    return false;
  });
}

export function githubBlockingMessage(reason) {
  return GITHUB_BLOCK_REASONS[reason] || null;
}

// Nota de sistema que substitui o texto genérico "publicação não autorizada":
// o modelo precisa saber a CAUSA para dizer a verdade ao usuário em vez de
// inventar que a ferramenta "não está habilitada nesta sessão".
export function githubPreflightNote(preflight) {
  if (!preflight?.connected) return null;
  // Chat comum (nenhum repositório vinculado) ou turno social: não há publicação
  // em questão, e avisar que ela "não está autorizada" só geraria ruído — e a
  // tentação de o modelo comentar isso com o usuário sem motivo.
  if (!preflight.repository || preflight.blockingReason === 'low_signal_turn') return null;
  if (preflight.writeAuthorized) {
    const acoes = [
      preflight.tools.push ? 'github_push' : null,
      preflight.tools.createPr ? 'github_create_pr' : null
    ].filter(Boolean).join(' e ');
    return `PUBLICAÇÃO AUTORIZADA nesta tarefa para ${preflight.repository} na branch "${preflight.branch}"${preflight.base ? ` (destino "${preflight.base}")` : ''}: você tem ${acoes}. Antes de enviar, confira o diff e publique somente o que está no escopo da missão. Só informe o link do Pull Request DEPOIS que a ferramenta devolver a URL.`;
  }
  const causa = githubBlockingMessage(preflight.blockingReason);
  if (!causa) return null;
  return `PUBLICAÇÃO NÃO AUTORIZADA nesta tarefa. Causa real: ${causa} Você NÃO tem github_push nem github_create_pr agora — e isso é uma questão de AUTORIZAÇÃO/ESTADO, não de a ferramenta "não existir no aplicativo". Deixe o trabalho validado e o commit local prontos, explique ao usuário exatamente esta causa e o que ele precisa fazer (por exemplo, tocar em "Autorizar publicação" no painel do projeto ou responder à confirmação). NUNCA rode git push/pull/fetch/clone pelo bash do sandbox: o backend bloqueia, o sandbox não tem credencial e insistir só queima etapas. Não invente link de Pull Request.`;
}
