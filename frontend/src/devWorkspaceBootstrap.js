import { projectContextText, permissionsPayloadFor } from './hooks/useDevProjects.js';

/**
 * Monta sessão Dev a partir do projeto ativo para inventário/vínculo viajarem no chat.
 * Sem isso o workspace abre "bonito" e o POST segue como chat genérico.
 * Devolve a sessão criada/existente, ou null se não houver projeto.
 */
export function seedDeveloperSessionFromActive({
  developerSession,
  project,
  current,
  setDeveloperSession,
}) {
  if (developerSession) return developerSession;
  if (!project) return null;
  const binding = project.binding || {};
  const session = {
    mode: project.mode || 'plan',
    projectId: binding.type === 'folder' ? (binding.folderId || null) : null,
    github: binding.type === 'github' && binding.repo
      ? { repo: binding.repo, branch: binding.branch || '' }
      : null,
    rules: projectContextText(project),
    devProjectId: project.id,
    conversationId: current?.id || null,
    permissions: permissionsPayloadFor(project),
  };
  setDeveloperSession(session);
  return session;
}

/**
 * Abre o painel Dev e troca o workspace — senão o modal fecha e a UI volta ao Estúdio.
 */
export function openDeveloperWorkspace({
  mode,
  activeMode,
  setDeveloperStartMode,
  setDeveloperOpen,
  setWorkspace,
}) {
  setDeveloperStartMode(mode || activeMode || 'plan');
  setDeveloperOpen(true);
  setWorkspace('developer');
}
