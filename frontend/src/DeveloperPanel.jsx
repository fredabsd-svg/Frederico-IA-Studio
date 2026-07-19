import React, { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Code2, FileSearch, FolderCog, FolderOpen, GitBranch, Hammer, ListChecks, Lock, ShieldCheck, Unlock } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';
import { GitHubIcon } from './ConnectorsPanel.jsx';

// Projetos vindos do conector GitHub entram no mesmo seletor de projeto das
// pastas do PC, com o valor prefixado ("gh:owner/repo") para distinguir.
const GITHUB_PREFIX = 'gh:';

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

export function DeveloperPanel({ onStart, onManageFolders, onOpenConnectors, onClose, initialMode }) {
  const [folders, setFolders] = useState(null);
  const [githubRepos, setGithubRepos] = useState(null); // null = carregando; [] = sem conector/sem repos
  const [githubConnected, setGithubConnected] = useState(false);
  const [branches, setBranches] = useState(null);
  const [branch, setBranch] = useState('');
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
    async function loadGithub() {
      try {
        const list = await (await fetch(`${API}/api/connectors`)).json();
        const gh = (Array.isArray(list) ? list : []).find(c => c.provider === 'github');
        setGithubConnected(!!gh?.connected);
        if (!gh?.connected) { setGithubRepos([]); return; }
        const repos = await (await fetch(`${API}/api/connectors/github/repos`)).json();
        setGithubRepos(Array.isArray(repos) ? repos : []);
      } catch {
        setGithubRepos([]);
      }
    }
    loadFolders();
    loadGithub();
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
    if (!folders || githubRepos === null || !projectId) return;
    const isGithub = projectId.startsWith(GITHUB_PREFIX);
    const stillExists = isGithub
      ? githubRepos.some(repo => `${GITHUB_PREFIX}${repo.full_name}` === projectId)
      : folders.some(folder => folder.id === projectId);
    if (!stillExists) setProjectId('');
  }, [folders, githubRepos, projectId]);

  const githubRepoName = projectId.startsWith(GITHUB_PREFIX) ? projectId.slice(GITHUB_PREFIX.length) : null;
  const githubRepo = githubRepoName ? (githubRepos || []).find(repo => repo.full_name === githubRepoName) || null : null;

  // Branches do repositório GitHub escolhido (a padrão vem pré-selecionada).
  useEffect(() => {
    if (!githubRepoName) { setBranches(null); setBranch(''); return; }
    let alive = true;
    setBranches(null);
    setBranch(githubRepo?.default_branch || '');
    (async () => {
      try {
        const data = await (await fetch(`${API}/api/connectors/github/branches?repo=${encodeURIComponent(githubRepoName)}`)).json();
        if (alive && Array.isArray(data)) setBranches(data);
        else if (alive) setBranches([]);
      } catch { if (alive) setBranches([]); }
    })();
    return () => { alive = false; };
  }, [githubRepoName]);

  const selectedMode = WORK_MODES.find(item => item.id === mode) || WORK_MODES[0];
  const project = !githubRepoName ? folders?.find(folder => folder.id === projectId) || null : null;
  const canWriteProject = mode === 'build' && (githubRepoName ? true : !!project?.writable);

  function changeRules(value) {
    setRules(value);
    if (projectId) localStorage.setItem(`fred_dev_rules_${projectId}`, value);
  }

  function prepareTask() {
    if (!brief.trim()) return;
    onStart({
      mode,
      projectId: project?.id || null,
      github: githubRepoName ? { repo: githubRepoName, branch: branch.trim() || githubRepo?.default_branch || '' } : null,
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
      <select value={projectId} onChange={event => setProjectId(event.target.value)} disabled={folders === null && githubRepos === null}>
        <option value="">Novo projeto ou arquivos da conversa</option>
        {(folders || []).length > 0 && <optgroup label="Pastas do computador">
          {(folders || []).map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
        </optgroup>}
        {(githubRepos || []).length > 0 && <optgroup label="GitHub">
          {(githubRepos || []).map(repo => <option key={repo.full_name} value={`${GITHUB_PREFIX}${repo.full_name}`}>{repo.full_name}{repo.private ? ' (privado)' : ''}</option>)}
        </optgroup>}
      </select>
      {folders === null && githubRepos === null
        ? <div className="working"><span className="spin"/><span>Carregando projeto...</span></div>
        : <>
          {project && <div className="devProjectStatus">
            <FolderOpen size={15}/><span title={project.host_path}>{project.host_path}</span>
            <b className={canWriteProject ? 'write' : 'read'}>{canWriteProject ? <Unlock size={13}/> : <Lock size={13}/>}{canWriteProject ? 'Escrita' : 'Leitura'}</b>
          </div>}
          {githubRepoName && <div className="devProjectStatus">
            <GitHubIcon size={15}/><span title={githubRepoName}>{githubRepoName}</span>
            <b className={canWriteProject ? 'write' : 'read'}>{canWriteProject ? <Unlock size={13}/> : <Lock size={13}/>}{canWriteProject ? 'Pode enviar (push)' : 'Só leitura'}</b>
          </div>}
          {!githubConnected && githubRepos !== null && <div className="muted small" style={{ marginTop: 6 }}>
            Quer trabalhar num repositório GitHub? <button type="button" className="linklike" onClick={onOpenConnectors} style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>Conecte a sua conta</button>.
          </div>}
        </>}
    </div>

    {githubRepoName && <div className="devField">
      <div className="devFieldHead"><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><GitBranch size={14}/> Branch</span></div>
      {branches === null
        ? <div className="working"><span className="spin"/><span>Carregando branches...</span></div>
        : <select value={branch} onChange={event => setBranch(event.target.value)}>
            {branches.length === 0 && branch && <option value={branch}>{branch}</option>}
            {branches.map(name => <option key={name} value={name}>{name}{name === githubRepo?.default_branch ? ' (padrão)' : ''}</option>)}
          </select>}
      {mode === 'build' && <p className="muted small" style={{ margin: '6px 0 0' }}>As mudanças serão enviadas para esta branch. Prefere não mexer direto na principal? Peça na missão (ex.: "crie uma branch ajuste-login e abra um Pull Request").</p>}
    </div>}

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
