import { useCallback, useEffect, useMemo, useState } from 'react';

// Projetos do Modo Desenvolvedor.
//
// Cada trabalho é um projeto independente com nome, descrição, tecnologias, um
// vínculo (pasta do PC, repositório GitHub ou nenhum), regras e uma "memória
// permanente" categorizada (item 8 da especificação). Tudo fica salvo neste
// navegador — o contexto do projeto NÃO se mistura com conversas comuns nem com
// outros projetos. A memória e as regras viajam para a IA pelo canal `rules`
// (que já chega ao system prompt do backend), então a IA "lembra" do projeto
// sem o usuário reexplicar tudo a cada conversa.

const STORE_KEY = 'fred_dev_projects_v1';
const ACTIVE_KEY = 'fred_dev_active_project_v1';

// Categorias da memória permanente (rótulo exibido nas telas).
export const MEMORY_FIELDS = [
  { key: 'arquitetura',  label: 'Arquitetura do sistema' },
  { key: 'decisoes',     label: 'Decisões técnicas' },
  { key: 'padroes',      label: 'Padrões de código' },
  { key: 'corrigidos',   label: 'Problemas já corrigidos' },
  { key: 'preferencias', label: 'Preferências do usuário' },
  { key: 'proximos',     label: 'Próximas etapas planejadas' }
];

function emptyMemory() {
  return MEMORY_FIELDS.reduce((acc, f) => { acc[f.key] = ''; return acc; }, {});
}

// AUTORIZAÇÃO DE PUBLICAÇÃO NO GITHUB — ações que ela pode conceder.
// A lista é a mesma do backend (`agent/githubAccess.js`), que RE-VALIDA tudo:
// nada aqui amplia permissão, isto só registra a decisão do usuário.
export const GITHUB_WRITE_ACTIONS = ['push', 'create_pr'];

function emptyPermissions() {
  // `commandGrants`: padrões de comando (política allow/ask/deny do backend)
  // que o usuário autorizou para este projeto ao confirmar um ask_user de
  // permissão. O backend RE-VALIDA cada padrão (só os `ask` da política dele
  // sobrevivem) — isto é o registro da decisão, não a permissão em si.
  return { githubWrite: false, githubWriteConfirmedAt: null, githubWriteScope: null, commandGrants: [] };
}

export function newDevProject(partial = {}) {
  const id = `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    name: '',
    description: '',
    techs: '',
    binding: { type: 'none' },
    rules: '',
    memory: emptyMemory(),
    permissions: emptyPermissions(),
    mode: 'plan',
    conversationIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
    // Garante que a memória tenha todas as chaves mesmo em projetos antigos.
    memory: { ...emptyMemory(), ...(partial.memory || {}) },
    permissions: { ...emptyPermissions(), ...(partial.permissions || {}) }
  };
}

// Monta a autorização a enviar ao backend, SÓ se o escopo registrado ainda
// corresponder ao vínculo atual do projeto. PURA (testável).
//
// Por que o escopo é conferido aqui também: mudar o repositório, a branch ou a
// branch base depois de autorizar é mudar o que foi autorizado. Nesse caso a
// permissão simplesmente não viaja — e a interface volta a pedir confirmação, em
// vez de publicar em outro lugar com um "sim" antigo.
export function githubWritePermissionFor(project, { base = null } = {}) {
  const perms = project?.permissions;
  const scope = perms?.githubWriteScope;
  if (!perms?.githubWrite || !scope?.repo) return null;
  const binding = project?.binding || {};
  if (binding.type !== 'github' || !binding.repo) return null;
  if (scope.repo !== binding.repo) return null;
  if (scope.branch !== (binding.branch || '')) return null;
  if (base && scope.base && scope.base !== base) return null;
  const actions = (scope.actions || []).filter(a => GITHUB_WRITE_ACTIONS.includes(a));
  if (!actions.length) return null;
  return {
    githubWrite: true,
    githubWriteConfirmedAt: perms.githubWriteConfirmedAt || null,
    githubWriteScope: { repo: scope.repo, branch: scope.branch, base: scope.base || null, actions }
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(p => ({
      ...newDevProject(),
      ...p,
      memory: { ...emptyMemory(), ...(p.memory || {}) },
      permissions: { ...emptyPermissions(), ...(p.permissions || {}) }
    }));
  } catch {
    return [];
  }
}

// Monta o texto de contexto do projeto (regras + memória) que é enviado à IA
// pelo canal `rules`. Só inclui campos preenchidos, para não poluir o prompt.
export function projectContextText(project) {
  if (!project) return '';
  const parts = [];
  if (project.name) parts.push(`PROJETO: ${project.name}`);
  if (project.description) parts.push(`Descrição: ${project.description}`);
  if (project.techs) parts.push(`Tecnologias: ${project.techs}`);
  const mem = project.memory || {};
  const memLines = MEMORY_FIELDS
    .filter(f => (mem[f.key] || '').trim())
    .map(f => `- ${f.label}: ${mem[f.key].trim()}`);
  if (memLines.length) parts.push(`MEMÓRIA DO PROJETO:\n${memLines.join('\n')}`);
  if ((project.rules || '').trim()) parts.push(`REGRAS DO PROJETO:\n${project.rules.trim()}`);
  return parts.join('\n\n');
}

// Reconstrói a sessão de desenvolvedor de uma conversa a partir do projeto dono
// (aquele cujo `conversationIds` inclui a conversa). Devolve o mesmo formato que
// o backend espera em `developer` (modo, vínculo pasta/GitHub, regras) ou null se
// a conversa não pertence a nenhum projeto. PURA (testável) — usada ao REABRIR
// uma conversa para que o vínculo com o repositório não se perca ao sair/voltar.
export function developerSessionForConversation(projects, conversationId) {
  if (!conversationId || !Array.isArray(projects)) return null;
  const project = projects.find(p => (p.conversationIds || []).includes(conversationId));
  if (!project) return null;
  const binding = project.binding || { type: 'none' };
  const github = binding.type === 'github' && binding.repo
    ? { repo: binding.repo, branch: binding.branch || '' }
    : null;
  const projectId = binding.type === 'folder' ? (binding.folderId || null) : null;
  return {
    mode: project.mode || 'plan',
    projectId,
    github,
    rules: projectContextText(project),
    devProjectId: project.id,
    conversationId,
    // A autorização de publicação viaja junto: é ela que faz `github_push` e
    // `github_create_pr` continuarem no inventário em turnos seguintes e depois
    // de reabrir a conversa. Sem isto, a permissão morria com o turno em que o
    // usuário a concedeu. As autorizações de comando (commandGrants) viajam
    // pelo mesmo canal e são re-validadas pelo backend.
    permissions: permissionsPayloadFor(project)
  };
}

// Payload de permissões enviado ao backend: autorização de publicação (quando
// o escopo ainda casa com o vínculo) + autorizações de comando. Null quando não
// há nada a enviar. PURA (testável).
export function permissionsPayloadFor(project, options = {}) {
  const github = githubWritePermissionFor(project, options);
  const grants = (project?.permissions?.commandGrants || []).filter(g => typeof g === 'string' && g.trim());
  if (!github && !grants.length) return null;
  return { ...(github || {}), ...(grants.length ? { commandGrants: grants } : {}) };
}

export function useDevProjects() {
  const [projects, setProjects] = useState(load);
  const [activeId, setActiveIdState] = useState(() => localStorage.getItem(ACTIVE_KEY) || '');

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(projects)); } catch {}
  }, [projects]);
  useEffect(() => {
    try { localStorage.setItem(ACTIVE_KEY, activeId || ''); } catch {}
  }, [activeId]);
  // Se o projeto ativo sumiu (excluído em outra aba), limpa a seleção.
  useEffect(() => {
    if (activeId && !projects.some(p => p.id === activeId)) setActiveIdState('');
  }, [projects, activeId]);

  const setActiveId = useCallback((id) => setActiveIdState(id || ''), []);

  const createProject = useCallback((partial = {}) => {
    const project = newDevProject(partial);
    setProjects(prev => [...prev, project]);
    setActiveIdState(project.id);
    return project;
  }, []);

  const updateProject = useCallback((id, patch) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== id) return p;
      const next = typeof patch === 'function' ? patch(p) : { ...p, ...patch };
      return { ...next, memory: { ...emptyMemory(), ...(next.memory || {}) }, updatedAt: new Date().toISOString() };
    }));
  }, []);

  const deleteProject = useCallback((id) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    setActiveIdState(cur => (cur === id ? '' : cur));
  }, []);

  // Registra a conversa como pertencente ao projeto (histórico de conversas).
  const linkConversation = useCallback((id, conversationId) => {
    if (!id || !conversationId) return;
    setProjects(prev => prev.map(p => {
      if (p.id !== id) return p;
      if ((p.conversationIds || []).includes(conversationId)) return p;
      return { ...p, conversationIds: [conversationId, ...(p.conversationIds || [])].slice(0, 50) };
    }));
  }, []);

  // AUTORIZAR a publicação — só por ação explícita do usuário (o botão
  // "Autorizar publicação", ou a confirmação de um `ask_user`). O escopo é
  // gravado junto: repositório, branch, branch base e ações. O backend confere
  // tudo de novo; isto é o registro da decisão, não a permissão em si.
  const authorizeGithubWrite = useCallback((id, { repo, branch, base = null, actions = GITHUB_WRITE_ACTIONS } = {}) => {
    if (!id || !repo) return;
    const allowed = actions.filter(a => GITHUB_WRITE_ACTIONS.includes(a));
    if (!allowed.length) return;
    setProjects(prev => prev.map(p => p.id === id ? {
      ...p,
      permissions: {
        githubWrite: true,
        githubWriteConfirmedAt: new Date().toISOString(),
        githubWriteScope: { repo, branch: branch || '', base: base || null, actions: allowed }
      },
      updatedAt: new Date().toISOString()
    } : p));
  }, []);

  const revokeGithubWrite = useCallback((id) => {
    if (!id) return;
    setProjects(prev => prev.map(p => p.id === id
      ? { ...p, permissions: emptyPermissions(), updatedAt: new Date().toISOString() }
      : p));
  }, []);

  // AUTORIZAR um padrão de comando (confirmação de um ask_user de permissão).
  // O padrão vem do carimbo do BACKEND (inputRequest.authorize), nunca de texto
  // do modelo; e o backend confere de novo antes de valer.
  const authorizeCommand = useCallback((id, { pattern } = {}) => {
    const clean = String(pattern || '').trim();
    if (!id || !clean) return;
    setProjects(prev => prev.map(p => {
      if (p.id !== id) return p;
      const current = p.permissions?.commandGrants || [];
      if (current.includes(clean)) return p;
      return {
        ...p,
        permissions: { ...emptyPermissions(), ...(p.permissions || {}), commandGrants: [...current, clean] },
        updatedAt: new Date().toISOString()
      };
    }));
  }, []);

  const active = useMemo(() => projects.find(p => p.id === activeId) || null, [projects, activeId]);

  return { projects, activeId, active, setActiveId, createProject, updateProject, deleteProject, linkConversation, authorizeGithubWrite, revokeGithubWrite, authorizeCommand };
}
