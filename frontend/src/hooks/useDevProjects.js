import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Projetos do Modo Desenvolvedor.
//
// Cada trabalho é um projeto independente com nome, descrição, tecnologias, um
// vínculo (pasta do PC, repositório GitHub ou nenhum), regras e uma "memória
// permanente" categorizada. Desde o ADR 0004, a FONTE DE VERDADE é o SERVIDOR
// (GET/PUT /api/dev-projects): trocar de navegador ou limpar dados não perde
// mais o vínculo repo/branch nem as permissões concedidas. O localStorage
// continua como CACHE (partida rápida e modo offline) e a migração do acervo
// antigo acontece UMA vez (POST /import), guardada por um marcador local.
//
// `constants.js` usa import.meta.env (Vite) — os imports dele são DINÂMICOS,
// dentro das funções de rede, para as funções puras continuarem testáveis em nó.

const STORE_KEY = 'fred_dev_projects_v1';
const ACTIVE_KEY = 'fred_dev_active_project_v1';
// Marcador do primeiro sync bem-sucedido: sem ele, um servidor vazio (projetos
// apagados em OUTRO dispositivo) seria "re-populado" pelo cache local antigo.
const SYNCED_KEY = 'fred_dev_projects_synced_v1';
const SYNC_DEBOUNCE_MS = 800;

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

// Converte a linha do SERVIDOR (snake_case, campos JSON já hidratados) para a
// forma do projeto no cliente. PURA (testável). Campos ausentes caem nos
// defaults de newDevProject — um projeto antigo do servidor nunca quebra a UI.
export function projectFromServer(row) {
  if (!row?.id || !row?.name) return null;
  return newDevProject({
    id: row.id,
    name: row.name,
    description: row.description || '',
    techs: row.techs || '',
    rules: row.rules || '',
    binding: row.binding && typeof row.binding === 'object' ? row.binding : { type: 'none' },
    memory: row.memory || {},
    permissions: row.permissions || {},
    mode: row.mode || 'plan',
    conversationIds: Array.isArray(row.conversationIds) ? row.conversationIds : [],
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString()
  });
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
  const projectsRef = useRef(projects);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  // Ids com mudança local ainda não enviada ao servidor (debounce por lote).
  const dirtyRef = useRef(new Set());
  const markDirty = useCallback((id) => { if (id) dirtyRef.current.add(id); }, []);

  // BOOTSTRAP (ADR 0004): o servidor é a fonte de verdade. Na primeira vez,
  // o acervo do localStorage sobe pelo /import; depois disso, o que o servidor
  // diz vale — inclusive "nenhum projeto" (apagado em outro dispositivo).
  // Falha de rede mantém o cache local, sem quebrar nada.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { API } = await import('../constants.js');
        const res = await fetch(`${API}/api/dev-projects`);
        if (!res.ok) return;
        let serverProjects = ((await res.json()).projects || []).map(projectFromServer).filter(Boolean);
        const alreadySynced = localStorage.getItem(SYNCED_KEY) === '1';
        const local = load();
        if (!serverProjects.length && local.length && !alreadySynced) {
          const imported = await fetch(`${API}/api/dev-projects/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projects: local })
          });
          if (!imported.ok) return; // tenta de novo na próxima carga
          serverProjects = ((await imported.json()).projects || []).map(projectFromServer).filter(Boolean);
        }
        if (!alive) return;
        try { localStorage.setItem(SYNCED_KEY, '1'); } catch {}
        setProjects(serverProjects);
      } catch { /* offline: o cache local segue valendo */ }
    })();
    return () => { alive = false; };
  }, []);

  // Sincronização das mudanças locais (debounce): cada projeto sujo sobe por
  // PUT com o estado MAIS RECENTE (projectsRef). Falha fica para a próxima
  // mudança ou o próximo bootstrap — nunca derruba a UI.
  useEffect(() => {
    if (!dirtyRef.current.size) return;
    const timer = setTimeout(() => {
      const ids = [...dirtyRef.current];
      dirtyRef.current.clear();
      (async () => {
        try {
          const { API } = await import('../constants.js');
          for (const id of ids) {
            const project = projectsRef.current.find(p => p.id === id);
            if (!project) continue;
            fetch(`${API}/api/dev-projects/${encodeURIComponent(id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(project)
            }).catch(() => {});
          }
        } catch {}
      })();
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projects]);

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
    markDirty(project.id);
    return project;
  }, [markDirty]);

  const updateProject = useCallback((id, patch) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== id) return p;
      const next = typeof patch === 'function' ? patch(p) : { ...p, ...patch };
      return { ...next, memory: { ...emptyMemory(), ...(next.memory || {}) }, updatedAt: new Date().toISOString() };
    }));
    markDirty(id);
  }, [markDirty]);

  const deleteProject = useCallback((id) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    setActiveIdState(cur => (cur === id ? '' : cur));
    dirtyRef.current.delete(id);
    // Exclusão vai direto ao servidor (sem debounce): é a mudança que não pode
    // se perder — e o servidor solta as conversas em vez de apagar histórico.
    (async () => {
      try {
        const { API } = await import('../constants.js');
        fetch(`${API}/api/dev-projects/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
      } catch {}
    })();
  }, []);

  // Registra a conversa como pertencente ao projeto (histórico de conversas).
  const linkConversation = useCallback((id, conversationId) => {
    if (!id || !conversationId) return;
    setProjects(prev => prev.map(p => {
      if (p.id !== id) return p;
      if ((p.conversationIds || []).includes(conversationId)) return p;
      return { ...p, conversationIds: [conversationId, ...(p.conversationIds || [])].slice(0, 50) };
    }));
    markDirty(id);
  }, [markDirty]);

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
    markDirty(id);
  }, [markDirty]);

  const revokeGithubWrite = useCallback((id) => {
    if (!id) return;
    setProjects(prev => prev.map(p => p.id === id
      ? { ...p, permissions: emptyPermissions(), updatedAt: new Date().toISOString() }
      : p));
    markDirty(id);
  }, [markDirty]);

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
    markDirty(id);
  }, [markDirty]);

  const active = useMemo(() => projects.find(p => p.id === activeId) || null, [projects, activeId]);

  return { projects, activeId, active, setActiveId, createProject, updateProject, deleteProject, linkConversation, authorizeGithubWrite, revokeGithubWrite, authorizeCommand };
}
