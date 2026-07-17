import React, { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Code2, FileSearch, FolderCog, FolderOpen, Hammer, ListChecks, Lock, ShieldCheck, Unlock } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';

const WORK_MODES = [
  {
    id: 'plan',
    label: 'Planejar',
    icon: ListChecks,
    steps: ['Mapear projeto', 'Definir plano', 'Listar riscos']
  },
  {
    id: 'build',
    label: 'Construir',
    icon: Hammer,
    steps: ['Entender contexto', 'Aplicar mudanças', 'Verificar resultado']
  },
  {
    id: 'review',
    label: 'Revisar',
    icon: ShieldCheck,
    steps: ['Ler alterações', 'Encontrar riscos', 'Priorizar achados']
  }
];

export function DeveloperPanel({ onStart, onManageFolders, onClose, initialMode }) {
  const [folders, setFolders] = useState(null);
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem('fred_dev_mode');
    return WORK_MODES.some(item => item.id === saved) ? saved : 'plan';
  });
  const [projectId, setProjectId] = useState(() => localStorage.getItem('fred_dev_project') || '');
  const [brief, setBrief] = useState('');
  const [rules, setRules] = useState('');

  useEffect(() => {
    async function loadFolders() {
      try {
        const response = await fetch(`${API}/api/pc-folders`);
        const data = await response.json();
        setFolders(Array.isArray(data) ? data : []);
      } catch {
        setFolders([]);
      }
    }
    loadFolders();
  }, []);

  useEffect(() => { localStorage.setItem('fred_dev_mode', mode); }, [mode]);
  useEffect(() => {
    if (WORK_MODES.some(item => item.id === initialMode)) setMode(initialMode);
  }, [initialMode]);
  useEffect(() => { localStorage.setItem('fred_dev_project', projectId); }, [projectId]);
  useEffect(() => {
    if (!projectId) { setRules(''); return; }
    setRules(localStorage.getItem(`fred_dev_rules_${projectId}`) || '');
  }, [projectId]);
  useEffect(() => {
    if (folders && projectId && !folders.some(folder => folder.id === projectId)) setProjectId('');
  }, [folders, projectId]);

  const selectedMode = WORK_MODES.find(item => item.id === mode) || WORK_MODES[0];
  const project = folders?.find(folder => folder.id === projectId) || null;
  const canWriteProject = mode === 'build' && !!project?.writable;

  function changeRules(value) {
    setRules(value);
    if (projectId) localStorage.setItem(`fred_dev_rules_${projectId}`, value);
  }

  function prepareTask() {
    if (!brief.trim()) return;
    onStart({
      mode,
      projectId: project?.id || null,
      brief: brief.trim(),
      rules: rules.trim()
    });
  }

  return <Drawer title="Modo desenvolvedor" icon={<Code2 size={18}/>} onClose={onClose} className="developerDrawer">
    <div className="devModeTabs" role="tablist" aria-label="Modo de trabalho">
      {WORK_MODES.map(item => {
        const Icon = item.icon;
        return <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} onClick={() => setMode(item.id)}>
          <Icon size={15}/><span>{item.label}</span>
        </button>;
      })}
    </div>

    <div className="devField">
      <div className="devFieldHead">
        <span>Projeto</span>
        <button type="button" className="devFolderButton" onClick={onManageFolders} title="Gerenciar pastas do computador" aria-label="Gerenciar pastas do computador"><FolderCog size={16}/></button>
      </div>
      <select value={projectId} onChange={event => setProjectId(event.target.value)} disabled={folders === null}>
        <option value="">Novo projeto ou arquivos da conversa</option>
        {(folders || []).map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
      </select>
      {folders === null
        ? <div className="working"><span className="spin"/><span>Carregando projeto...</span></div>
        : project && <div className="devProjectStatus">
            <FolderOpen size={15}/><span title={project.host_path}>{project.host_path}</span>
            <b className={canWriteProject ? 'write' : 'read'}>{canWriteProject ? <Unlock size={13}/> : <Lock size={13}/>}{canWriteProject ? 'Escrita' : 'Leitura'}</b>
          </div>}
    </div>

    <label className="devBrief">Missão
      <textarea value={brief} onChange={event => setBrief(event.target.value)} placeholder="Ex.: corrigir o fluxo de login sem mudar a interface" rows={5}/>
    </label>

    <details className="devRules">
      <summary><BookOpen size={15}/> Regras do projeto</summary>
      <textarea value={rules} onChange={event => changeRules(event.target.value)} placeholder="Ex.: manter a API pública; não adicionar dependências" rows={4}/>
    </details>

    <div className="devFlow" aria-label={`Fluxo para ${selectedMode.label.toLowerCase()}`}>
      {selectedMode.steps.map((step, index) => <React.Fragment key={step}>
        <span>{index + 1}. {step}</span>{index < selectedMode.steps.length - 1 && <ArrowRight size={14}/>}
      </React.Fragment>)}
    </div>

    <div className="devActionRow">
      <span className="devModeBadge"><FileSearch size={14}/>{selectedMode.label}</span>
      <button type="button" className="primary" onClick={prepareTask} disabled={!brief.trim()}><ArrowRight size={16}/> Abrir tarefa</button>
    </div>
  </Drawer>;
}
