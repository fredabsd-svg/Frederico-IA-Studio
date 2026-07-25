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
    mode: 'plan',
    conversationIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
    // Garante que a memória tenha todas as chaves mesmo em projetos antigos.
    memory: { ...emptyMemory(), ...(partial.memory || {}) }
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(p => ({ ...newDevProject(), ...p, memory: { ...emptyMemory(), ...(p.memory || {}) } }));
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
  };
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

  const active = useMemo(() => projects.find(p => p.id === activeId) || null, [projects, activeId]);

  return { projects, activeId, active, setActiveId, createProject, updateProject, deleteProject, linkConversation };
}
