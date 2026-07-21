import React from 'react';
import {
  FolderGit2, FolderOpen, FileText, RefreshCw, PanelLeftClose, PanelLeftOpen,
  Plus, Lock, Unlock, ChevronRight, MessagesSquare, Download
} from 'lucide-react';
import { GitHubIcon } from '../ConnectorsPanel.jsx';
import { DEV_WORK_MODES } from '../constants.js';
import { DEV_MODE_ICON } from '../DeveloperPanel.jsx';

// Explorador do Modo Desenvolvedor (coluna esquerda do ambiente).
// Reúne o projeto ativo (nome, vínculo, permissão, modo), os arquivos presentes
// no workspace da conversa atual e o histórico de conversas do projeto.

function bindingLabel(binding) {
  if (!binding || binding.type === 'none') return { text: 'Sem vínculo · arquivos da conversa', github: false };
  if (binding.type === 'github') return { text: binding.repo + (binding.branch ? ` (${binding.branch})` : ''), github: true };
  return { text: binding.folderId ? 'Pasta do computador' : 'Sem vínculo', github: false };
}

export function DevProjectRail({
  collapsed, onToggle, projects, active, onSelectProject, onNewTask, onManageFolders,
  files, onRefreshFiles, filesLoading, downloadUrl, conversationId, recentTasks, onOpenTask
}) {
  if (collapsed) {
    return <aside className="devRail devRailLeft collapsed">
      <button className="devRailExpand" onClick={onToggle} title="Mostrar o explorador" aria-label="Mostrar o explorador"><PanelLeftOpen size={17}/></button>
      <span className="devRailStripLabel">Explorador</span>
    </aside>;
  }

  const bind = active ? bindingLabel(active.binding) : null;
  const mode = active ? DEV_WORK_MODES.find(m => m.id === active.mode) : null;
  const ModeIcon = mode ? (DEV_MODE_ICON[mode.id] || FolderGit2) : FolderGit2;

  return <aside className="devRail devRailLeft" aria-label="Explorador do projeto">
    <div className="devRailHead">
      <span><FolderGit2 size={15}/> Explorador</span>
      <button className="devRailCollapse" onClick={onToggle} title="Recolher" aria-label="Recolher o explorador"><PanelLeftClose size={16}/></button>
    </div>

    <div className="devRailScroll">
      <div className="devRailSection">
        <label className="devRailLabel">Projeto</label>
        <select className="devRailSelect" value={active?.id || ''} onChange={e => onSelectProject(e.target.value)}>
          {!active && <option value="">Nenhum projeto ativo</option>}
          {projects.map(p => <option key={p.id} value={p.id}>{p.name || 'Projeto sem nome'}</option>)}
        </select>
        <button className="devRailBtn primary" onClick={onNewTask}><Plus size={15}/> Nova tarefa</button>
      </div>

      {active && <div className="devRailSection">
        <div className="devProjectCard">
          <div className="devProjectCardHead">
            <ModeIcon size={14}/>
            <b>{active.name || 'Projeto sem nome'}</b>
          </div>
          {active.description && <p className="devProjectCardDesc">{active.description}</p>}
          {active.techs && <div className="devProjectTechs">{active.techs.split(/[,;]+/).map(t => t.trim()).filter(Boolean).map((t, i) => <span key={i}>{t}</span>)}</div>}
          <div className={`devProjectBind ${bind.github ? 'gh' : ''}`}>
            {bind.github ? <GitHubIcon size={13}/> : <FolderOpen size={13}/>}
            <span title={bind.text}>{bind.text}</span>
            {mode && <b className={mode.write ? 'write' : 'read'}>{mode.write ? <Unlock size={11}/> : <Lock size={11}/>}{mode.write ? 'Edita' : 'Leitura'}</b>
            }
          </div>
        </div>
      </div>}

      <div className="devRailSection">
        <div className="devRailLabelRow">
          <label className="devRailLabel">Arquivos da tarefa</label>
          <button className="devRailMini" onClick={onRefreshFiles} disabled={!conversationId || filesLoading} title="Atualizar" aria-label="Atualizar arquivos">
            {filesLoading ? <span className="spin sm"/> : <RefreshCw size={13}/>}
          </button>
        </div>
        {!conversationId && <p className="devRailEmpty">Inicie uma tarefa para ver os arquivos analisados e gerados aqui.</p>}
        {conversationId && (files || []).length === 0 && <p className="devRailEmpty">Nenhum arquivo ainda. Anexos e arquivos gerados pela IA aparecem aqui.</p>}
        <ul className="devFileList">
          {(files || []).map(f => <li key={f.id || f.path}>
            <a className="devFileItem" href={downloadUrl(f.path)} target="_blank" rel="noreferrer" title={`${f.name} — abrir`}>
              <FileText size={14}/>
              <span className="devFileName">{f.name}</span>
              <span className="devFileKind">{f.kind === 'upload' ? 'anexo' : 'gerado'}</span>
              <Download size={13} className="devFileDl"/>
            </a>
          </li>)}
        </ul>
      </div>

      {active && (recentTasks || []).length > 0 && <div className="devRailSection">
        <label className="devRailLabel"><MessagesSquare size={13}/> Tarefas recentes</label>
        <ul className="devTaskList">
          {recentTasks.map(t => <li key={t.id}>
            <button className={`devTaskItem ${t.id === conversationId ? 'active' : ''}`} onClick={() => onOpenTask(t.id)} title={t.title}>
              <span className={`devTaskDot ${t.id === conversationId ? 'active' : ''}`}/>
              <span className="devTaskTitle">{t.title}</span>
            </button>
          </li>)}
        </ul>
      </div>}

      <button className="devRailBtn ghost" onClick={onManageFolders}><ChevronRight size={14}/> Gerenciar pastas do PC</button>
    </div>
  </aside>;
}
