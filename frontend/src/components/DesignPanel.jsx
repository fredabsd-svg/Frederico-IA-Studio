import React, { useEffect, useState } from 'react';
import { X, LayoutTemplate } from 'lucide-react';
import { useDesign } from '../hooks/useDesign.js';
import { DesignHome } from './DesignHome.jsx';
import { DesignNewProject } from './DesignNewProject.jsx';
import { DesignEditor } from './DesignEditor.jsx';
import { DesignSystemSettings } from './DesignSystemSettings.jsx';

// Casca do Modo Design: ocupa a tela inteira e alterna entre as quatro telas.
//
// É um espaço de trabalho, não um painel de configuração — por isso ocupa tudo
// em vez de virar uma gaveta lateral. A prévia precisa de largura para mostrar
// o design como ele é; espremida numa gaveta, a tela não cumpriria o que
// promete.
export function DesignPanel({ onClose, model = '', askConfirm }) {
  const design = useDesign();
  const [view, setView] = useState('home'); // home | new | editor | systems

  useEffect(() => { design.loadProjects(); design.loadSystems(); }, []); // eslint-disable-line

  // Esc fecha o modo — mas não quando o foco está num campo de texto, senão
  // apertar Esc para desfazer uma digitação fecharia a tela inteira.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function openProject(id) {
    const project = await design.openProject(id);
    if (project) setView('editor');
  }

  async function createProject(input) {
    const project = await design.createProject({ ...input, model });
    if (project) setView('editor');
  }

  async function deleteProject(project) {
    const ok = await askConfirm({
      title: 'Apagar projeto de design',
      message: `“${project.title}” e todas as suas versões serão apagados. Não dá para desfazer.`,
      confirmLabel: 'Apagar',
      destructive: true,
    });
    if (ok) await design.removeProject(project.id);
  }

  return (
    <div className="dsOverlay" role="dialog" aria-modal="true" aria-label="Modo Design">
      <div className="dsShell">
        <div className="dsShellBar">
          <span className="dsShellBrand"><LayoutTemplate size={16} /> Modo Design</span>
          <button type="button" className="dsClose" onClick={onClose} aria-label="Fechar o Modo Design"><X size={18} /></button>
        </div>

        <div className="dsShellBody">
          {view === 'home' && (
            <DesignHome
              projects={design.projects}
              loading={design.loading}
              onNew={() => { design.setError(''); setView('new'); }}
              onOpen={openProject}
              onDelete={deleteProject}
              onOpenSystems={() => { design.setError(''); setView('systems'); }}
            />
          )}

          {view === 'new' && (
            <DesignNewProject
              systems={design.systems}
              busy={design.busy}
              error={design.error}
              onCreate={createProject}
              onCancel={() => { design.setError(''); setView('home'); }}
            />
          )}

          {view === 'editor' && design.project && (
            <DesignEditor
              project={design.project}
              busy={design.busy}
              error={design.error}
              model={model}
              onBack={() => { design.closeProject(); setView('home'); }}
              onGenerate={(prompt) => design.generate(design.project.id, prompt, model)}
              onRevert={(versionId) => design.revert(design.project.id, versionId)}
              onRename={(title) => design.renameProject(design.project.id, title)}
            />
          )}

          {view === 'systems' && (
            <DesignSystemSettings
              systems={design.systems}
              error={design.error}
              onBack={() => { design.setError(''); setView('home'); }}
              onSave={design.saveSystem}
              onDelete={design.removeSystem}
            />
          )}
        </div>
      </div>
    </div>
  );
}
