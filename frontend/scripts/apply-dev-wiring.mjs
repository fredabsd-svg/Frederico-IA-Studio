#!/usr/bin/env node
/**
 * Aplica o wiring do Modo Dev DIRETO no App.jsx fonte (mesmo efeito do plugin).
 * Uso (git local): node frontend/scripts/apply-dev-wiring.mjs && git add frontend/src/App.jsx
 * Depois: remover o plugin de vite.config.js e deletar appDevNinoPatchPlugin.js.
 * O workflow bake-dev-wiring.yml aplica isto no CI e faz commit do App.jsx.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, '..', 'src', 'App.jsx');
let code = fs.readFileSync(appPath, 'utf8');
if (code.includes("from './devWorkspaceBootstrap.js'")) {
  console.log('apply-dev-wiring: App.jsx já contém o wiring — nada a fazer.');
  process.exit(0);
}

const steps = [];
const apply = (from, to, label) => {
  if (!code.includes(from)) {
    console.error(`apply-dev-wiring: âncora não encontrada: ${label}`);
    process.exit(1);
  }
  code = code.replace(from, to);
  steps.push(label);
};

apply(
  `import { useDevProjects, projectContextText, developerSessionForConversation, permissionsPayloadFor } from './hooks/useDevProjects.js';`,
  `import { useDevProjects, projectContextText, developerSessionForConversation, permissionsPayloadFor } from './hooks/useDevProjects.js';
import { seedDeveloperSessionFromActive, openDeveloperWorkspace } from './devWorkspaceBootstrap.js';`,
  'import-bootstrap',
);

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
      const seeded = seedDeveloperSessionFromActive({
        developerSession,
        project: devProjects.active,
        current,
        setDeveloperSession,
      });
      if (!seeded) {
        setDeveloperStartMode(devProjects.active?.mode || 'plan');
        setDeveloperOpen(true);
      }
    }
  }

  function openDeveloper(mode) {
    // Sem modo explícito (ex.: botão da barra lateral), herda o modo salvo do
    // projeto ativo para não sobrescrever a preferência do usuário.
    // Sem setWorkspace('developer'), o painel abria em cima do Estúdio e as
    // colunas só apareciam depois de "Iniciar tarefa" — fechar o modal voltava
    // ao chat genérico.
    openDeveloperWorkspace({
      mode,
      activeMode: devProjects.active?.mode,
      setDeveloperStartMode,
      setDeveloperOpen,
      setWorkspace,
    });
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

fs.writeFileSync(appPath, code);
console.log('apply-dev-wiring: ok →', steps.join(', '));
console.log('Próximo: remover appDevNinoPatchPlugin de vite.config.js e deletar o plugin.\n');
