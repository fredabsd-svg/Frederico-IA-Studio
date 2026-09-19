/**
 * Patches cirúrgicos de Modo Dev no App.jsx (build/dev).
 *
 * O App.jsx monolítico (~115 KB) excede o limite de payload do MCP usado por
 * agentes remotos; por isso o wiring ainda entra aqui no transform. A lógica
 * canônica vive em `devWorkspaceBootstrap.js` — este plugin só injeta as
 * chamadas no App.jsx. Quando o App.jsx fonte já contém o import de
 * `devWorkspaceBootstrap`, o plugin vira no-op (idempotente).
 *
 * Remover: aplicar `node frontend/scripts/apply-dev-wiring.mjs` com git local,
 * commitar App.jsx, e tirar este plugin do vite.config.js.
 */
export function appDevNinoPatchPlugin() {
  return {
    name: 'app-dev-nino-patch',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/App.jsx')) return null;
      // Já no fonte: nada a fazer (evita double-patch e permite remover o plugin).
      if (code.includes("from './devWorkspaceBootstrap.js'") || code.includes('from \"./devWorkspaceBootstrap.js\"')) {
        return null;
      }
      let next = code;
      const apply = (from, to, label) => {
        if (!next.includes(from)) {
          this.warn(`[app-dev-nino-patch] âncora não encontrada: ${label}`);
          return;
        }
        next = next.replace(from, to);
      };

      apply(
        `import { useDevProjects, projectContextText, developerSessionForConversation, permissionsPayloadFor } from './hooks/useDevProjects.js';`,
        `import { useDevProjects, projectContextText, developerSessionForConversation, permissionsPayloadFor } from './hooks/useDevProjects.js';\nimport { seedDeveloperSessionFromActive, openDeveloperWorkspace } from './devWorkspaceBootstrap.js';`,
        'import-bootstrap',
      );

      apply(
        `  function changeWorkspace(next) {\n    if (!WORKSPACES.some(item => item.id === next)) return;\n    setWorkspace(next);\n    setMenuOpen(false);\n    setTopActionsOpen(false);\n    if (next === 'focus') {\n      setSideHidden(true);\n      localStorage.setItem('fred_side_hidden', '1');\n    } else if (workspace === 'focus') {\n      setSideHidden(false);\n      localStorage.setItem('fred_side_hidden', '0');\n    }\n  }\n\n  function openDeveloper(mode) {\n    // Sem modo explícito (ex.: botão da barra lateral), herda o modo salvo do\n    // projeto ativo para não sobrescrever a preferência do usuário.\n    setDeveloperStartMode(mode || devProjects.active?.mode || 'plan');\n    setDeveloperOpen(true);\n  }`,
        `  function changeWorkspace(next) {\n    if (!WORKSPACES.some(item => item.id === next)) return;\n    setWorkspace(next);\n    setMenuOpen(false);\n    setTopActionsOpen(false);\n    if (next === 'focus') {\n      setSideHidden(true);\n      localStorage.setItem('fred_side_hidden', '1');\n    } else if (workspace === 'focus') {\n      setSideHidden(false);\n      localStorage.setItem('fred_side_hidden', '0');\n    }\n    // Entrar no workspace Desenvolvedor sem sessão deixava as colunas montadas\n    // mas o envio ia sem mode/github/permissions — chat genérico com casca de IDE.\n    if (next === 'developer') {\n      const seeded = seedDeveloperSessionFromActive({\n        developerSession,\n        project: devProjects.active,\n        current,\n        setDeveloperSession,\n      });\n      if (!seeded) {\n        setDeveloperStartMode(devProjects.active?.mode || 'plan');\n        setDeveloperOpen(true);\n      }\n    }\n  }\n\n  function openDeveloper(mode) {\n    // Sem modo explícito (ex.: botão da barra lateral), herda o modo salvo do\n    // projeto ativo para não sobrescrever a preferência do usuário.\n    // Sem setWorkspace('developer'), o painel abria em cima do Estúdio e as\n    // colunas só apareciam depois de "Iniciar tarefa" — fechar o modal voltava\n    // ao chat genérico.\n    openDeveloperWorkspace({\n      mode,\n      activeMode: devProjects.active?.mode,\n      setDeveloperStartMode,\n      setDeveloperOpen,\n      setWorkspace,\n    });\n  }`,
        'changeWorkspace+openDeveloper',
      );

      apply(
        `<button onClick={() => setDeveloperSession(null)} title="Sair do modo desenvolvedor" aria-label="Sair do modo desenvolvedor"><X size={14}/></button>`,
        `<button onClick={() => {\n            setDeveloperSession(null);\n            setDeveloperStartMode(devProjects.active?.mode || 'plan');\n            setDeveloperOpen(true);\n          }} title="Sair do modo desenvolvedor" aria-label="Sair do modo desenvolvedor"><X size={14}/></button>`,
        'exit-developer-session',
      );

      apply(
        `placeholder={listening ? 'Ouvindo... fale agora' : (webSearch ? 'Pesquisa na internet ativada — pergunte algo atual...' : 'Peça para analisar arquivos, gerar Word, Excel, PDF...')}`,
        `placeholder={listening ? 'Ouvindo... fale agora' : (workspace === 'developer'\n              ? (developerSession\n                ? 'Descreva a mudança, o bug ou a pergunta sobre o projeto…'\n                : 'Prepare uma tarefa (Planejar/Implementar) para ativar ferramentas de código…')\n              : (webSearch ? 'Pesquisa na internet ativada — pergunte algo atual...' : 'Peça para analisar arquivos, gerar Word, Excel, PDF...'))}`,
        'composer-placeholder-dev',
      );

      if (next === code) return null;
      return next;
    },
  };
}
