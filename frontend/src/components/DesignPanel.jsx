import React, { useEffect, useRef, useState } from 'react';
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
export function DesignPanel({ onClose, model = '', allModels = [], askConfirm }) {
  const design = useDesign();
  const [view, setView] = useState('home'); // home | new | editor | systems

  useEffect(() => { design.loadProjects(); design.loadSystems(); }, []); // eslint-disable-line

  // Esc fecha o modo — mas não quando ele pertence a outra coisa.
  //
  // Dois casos, os dois encontrados na prática:
  //   * foco num campo de texto: Esc ali é "desfazer o que eu digitei", e
  //     fechar a tela inteira faria a pessoa perder o pedido pela metade;
  //   * um menu suspenso aberto (o seletor de modelo): Esc é para fechar O
  //     MENU. O teste de navegador pegou isto — apertar Esc para dispensar a
  //     lista de modelos derrubava o Modo Design e voltava para o chat.
  //
  // A checagem do menu é pelo DOM porque o ModelPicker guarda o próprio estado
  // de "aberto" e não o expõe; a presença de `.mpPanel` é o sinal disponível.
  //
  // Mas ela precisa acontecer na fase de CAPTURA, e essa parte custou uma
  // depuração: o ModelPicker escuta no `document` (fase de bolha), que roda
  // ANTES de um ouvinte de `window`, e o React trata `keydown` como evento
  // discreto — o estado é descarregado na hora, não em lote. Ou seja: quando o
  // ouvinte daqui rodava, o painel já tinha saído do DOM e a checagem não via
  // nada. A captura no `window` é o primeiro passo de toda a propagação, então
  // é o único momento em que dá para saber que havia um menu aberto quando a
  // tecla desceu.
  const menuAbertoNaTecla = useRef(false);
  useEffect(() => {
    function onKeyCapture(e) {
      if (e.key === 'Escape') menuAbertoNaTecla.current = Boolean(document.querySelector('.mpPanel'));
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (menuAbertoNaTecla.current) return;
      onClose();
    }
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true);
      window.removeEventListener('keydown', onKey);
    };
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
              models={allModels}
              model={model}
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
              allModels={allModels}
              onBack={() => { design.closeProject(); setView('home'); }}
              onGenerate={(prompt, target) => design.generate(design.project.id, prompt, model, target)}
              onGenerateImage={(prompt, modelo) => design.generateImage(design.project.id, prompt, modelo)}
              onListImages={(projectId) => design.listImages(projectId)}
              onRemoveImage={(projectId, imageId) => design.removeImage(projectId, imageId)}
              onRevert={(versionId) => design.revert(design.project.id, versionId)}
              onRename={(title) => design.renameProject(design.project.id, title)}
              onSaveAdjustments={(ajustes) => design.saveAdjustments(design.project.id, ajustes)}
              onSaveModel={(modelRef) => design.saveModel(design.project.id, modelRef)}
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
