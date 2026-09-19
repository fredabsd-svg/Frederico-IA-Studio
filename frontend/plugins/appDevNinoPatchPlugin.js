/**
 * Patches cirúrgicos de Modo Dev no App.jsx (build/dev).
 * O App.jsx monolítico (~115 KB) não cabe no limite de payload do MCP (~15 KB);
 * por isso as correções de wiring entram aqui, sem reescrever o arquivo inteiro.
 * Nino ocultar/mostrar vive em Companion.jsx (botões Ocultar / Mostrar Nino).
 */
export function appDevNinoPatchPlugin() {
  return {
    name: 'app-dev-nino-patch',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/App.jsx')) return null;
      let next = code;
      const apply = (from, to, label) => {
        if (!next.includes(from)) {
          this.warn(`[app-dev-nino-patch] âncora não encontrada: ${label}`);
          return;
        }
        next = next.replace(from, to);
      };

      apply(
        `  function changeWorkspace(next) {
    if (!WORKSPACES.some(item => item.id === next)) return;
    setWorkspace(next);
    setMenuOpen(false);
    setTopActionsOpen(false);
    if (next === 'focus') {
      setSideHidden(true);
      localStorage.setItem('fred_side_hidden', '1');
    } else if (workspace === 'focus') {
      setSideHidden(false);
      localStorage.setItem('fred_side_hidden', '0');
    }
  }

  function openDeveloper(mode) {
    // Sem modo explícito (ex.: botão da barra lateral), herda o modo salvo do
    // projeto ativo para não sobrescrever a preferência do usuário.
    setDeveloperStartMode(mode || devProjects.active?.mode || 'plan');
    setDeveloperOpen(true);
  }`,
        `  function changeWorkspace(next) {
    if (!WORKSPACES.some(item => item.id === next)) return;
    setWorkspace(next);
    setMenuOpen(false);
    setTopActionsOpen(false);
    if (next === 'focus') {
      setSideHidden(true);
      localStorage.setItem('fred_side_hidden', '1');
    } else if (workspace === 'focus') {
      setSideHidden(false);
      localStorage.setItem('fred_side_hidden', '0');
    }
    // Entrar no workspace Desenvolvedor sem sessão deixava as colunas montadas
    // mas o envio ia sem mode/github/permissions — chat genérico com casca de IDE.
    if (next === 'developer') {
      const seeded = seedDeveloperSessionFromActive();
      if (!seeded) {
        setDeveloperStartMode(devProjects.active?.mode || 'plan');
        setDeveloperOpen(true);
      }
    }
  }

  // Monta uma sessão a partir do projeto ativo para o inventário de ferramentas
  // e o vínculo (GitHub/pasta) viajarem com o chat. Devolve a sessão ou null.
  function seedDeveloperSessionFromActive() {
    if (developerSession) return developerSession;
    const project = devProjects.active;
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

  function openDeveloper(mode) {
    // Sem modo explícito (ex.: botão da barra lateral), herda o modo salvo do
    // projeto ativo para não sobrescrever a preferência do usuário.
    setDeveloperStartMode(mode || devProjects.active?.mode || 'plan');
    setDeveloperOpen(true);
    // Sem isto, o painel abria em cima do Estúdio e as colunas (explorador,
    // atividade, terminal) só apareciam DEPOIS de "Iniciar tarefa" — o usuário
    // fechava o modal e caía de volta no chat genérico.
    setWorkspace('developer');
  }`,
        'changeWorkspace+openDeveloper',
      );

      apply(
        `<button onClick={() => setDeveloperSession(null)} title="Sair do modo desenvolvedor" aria-label="Sair do modo desenvolvedor"><X size={14}/></button>`,
        `<button onClick={() => {
            setDeveloperSession(null);
            setDeveloperStartMode(devProjects.active?.mode || 'plan');
            setDeveloperOpen(true);
          }} title="Sair do modo desenvolvedor" aria-label="Sair do modo desenvolvedor"><X size={14}/></button>`,
        'exit-developer-session',
      );

      apply(
        `placeholder={listening ? 'Ouvindo... fale agora' : (webSearch ? 'Pesquisa na internet ativada — pergunte algo atual...' : 'Peça para analisar arquivos, gerar Word, Excel, PDF...')}`,
        `placeholder={listening ? 'Ouvindo... fale agora' : (workspace === 'developer'
              ? (developerSession
                ? 'Descreva a mudança, o bug ou a pergunta sobre o projeto…'
                : 'Prepare uma tarefa (Planejar/Implementar) para ativar ferramentas de código…')
              : (webSearch ? 'Pesquisa na internet ativada — pergunte algo atual...' : 'Peça para analisar arquivos, gerar Word, Excel, PDF...'))}`,
        'composer-placeholder-dev',
      );

      if (next === code) return null;
      return next;
    },
  };
}
