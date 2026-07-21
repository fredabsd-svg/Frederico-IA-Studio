import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, BookOpen, Code2, FolderCog, FolderOpen, GitBranch, Lock, Unlock,
  MessageCircleQuestion, ListChecks, Hammer, Bug, ShieldCheck, Bot, Plus, Trash2, FolderGit2
} from 'lucide-react';
import { API, DEV_WORK_MODES } from './constants.js';
import { Drawer } from './components.jsx';
import { GitHubIcon } from './ConnectorsPanel.jsx';
import { newDevProject } from './hooks/useDevProjects.js';

// Ícones de cada modo de trabalho (DEV_WORK_MODES.icon → componente lucide).
export const DEV_MODE_ICON = {
  ask: MessageCircleQuestion, plan: ListChecks, build: Hammer, fix: Bug, review: ShieldCheck, auto: Bot
};

// Repositórios do conector GitHub entram no seletor de vínculo com o valor
// prefixado ("gh:owner/repo") para distinguir das pastas do PC.
const GITHUB_PREFIX = 'gh:';

// Converte o vínculo do projeto para o valor do <select> (e vice-versa).
function bindingToValue(binding) {
  if (!binding) return '';
  if (binding.type === 'folder') return binding.folderId || '';
  if (binding.type === 'github') return binding.repo ? `${GITHUB_PREFIX}${binding.repo}` : '';
  return '';
}

export function DeveloperPanel({ devProjects, onStart, onManageFolders, onOpenConnectors, onClose, initialMode }) {
  const { projects, active, activeId, setActiveId, createProject, updateProject, deleteProject } = devProjects;

  const [folders, setFolders] = useState(null);
  const [githubRepos, setGithubRepos] = useState(null); // null = carregando; [] = sem conector/sem repos
  const [githubConnected, setGithubConnected] = useState(false);
  const [branches, setBranches] = useState(null);
  const [brief, setBrief] = useState('');

  // Se não há projeto ativo ao abrir, começamos um rascunho na tela para o
  // usuário criar o primeiro projeto sem fricção.
  const [draft, setDraft] = useState(() => (active ? null : newDevProject({ mode: initialMode || 'plan' })));
  const project = active || draft;
  const isDraft = !active;

  useEffect(() => {
    async function loadFolders() {
      try {
        const response = await fetch(`${API}/api/pc-folders`);
        const data = await response.json();
        setFolders(Array.isArray(data) ? data : []);
      } catch { setFolders([]); }
    }
    async function loadGithub() {
      try {
        const list = await (await fetch(`${API}/api/connectors`)).json();
        const gh = (Array.isArray(list) ? list : []).find(c => c.provider === 'github');
        setGithubConnected(!!gh?.connected);
        if (!gh?.connected) { setGithubRepos([]); return; }
        const repos = await (await fetch(`${API}/api/connectors/github/repos`)).json();
        setGithubRepos(Array.isArray(repos) ? repos : []);
      } catch { setGithubRepos([]); }
    }
    loadFolders();
    loadGithub();
  }, []);

  // Aplica o modo inicial pedido pelo atalho (Planejar/Implementar/Revisar...).
  useEffect(() => {
    if (DEV_WORK_MODES.some(m => m.id === initialMode)) patch({ mode: initialMode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMode]);

  // Atualiza o projeto ativo (persistido) ou o rascunho local.
  function patch(changes) {
    if (isDraft) setDraft(prev => ({ ...prev, ...changes }));
    else updateProject(activeId, changes);
  }
  function patchMemory(key, value) {
    if (isDraft) setDraft(prev => ({ ...prev, memory: { ...prev.memory, [key]: value } }));
    else updateProject(activeId, p => ({ ...p, memory: { ...p.memory, [key]: value } }));
  }

  const binding = project?.binding || { type: 'none' };
  const bindingValue = bindingToValue(binding);
  const githubRepoName = binding.type === 'github' ? binding.repo : null;
  const githubRepo = githubRepoName ? (githubRepos || []).find(r => r.full_name === githubRepoName) || null : null;
  const folder = binding.type === 'folder' ? (folders || []).find(f => f.id === binding.folderId) || null : null;

  const mode = DEV_WORK_MODES.find(m => m.id === project?.mode) || DEV_WORK_MODES[1];
  const canWriteProject = mode.write && (githubRepoName ? true : !!folder?.writable);

  // Branches do repositório GitHub vinculado (a padrão vem pré-selecionada).
  useEffect(() => {
    if (!githubRepoName) { setBranches(null); return; }
    let alive = true;
    setBranches(null);
    (async () => {
      try {
        const data = await (await fetch(`${API}/api/connectors/github/branches?repo=${encodeURIComponent(githubRepoName)}`)).json();
        if (alive) setBranches(Array.isArray(data) ? data : []);
      } catch { if (alive) setBranches([]); }
    })();
    return () => { alive = false; };
  }, [githubRepoName]);

  function changeBinding(value) {
    if (!value) { patch({ binding: { type: 'none' } }); return; }
    if (value.startsWith(GITHUB_PREFIX)) {
      const repo = value.slice(GITHUB_PREFIX.length);
      const def = (githubRepos || []).find(r => r.full_name === repo)?.default_branch || '';
      patch({ binding: { type: 'github', repo, branch: def } });
    } else {
      patch({ binding: { type: 'folder', folderId: value } });
    }
  }

  function selectProject(id) {
    if (id === '__new__') { setDraft(newDevProject({ mode: mode.id })); setActiveId(''); return; }
    setDraft(null);
    setActiveId(id);
  }

  function removeProject() {
    if (!activeId) return;
    deleteProject(activeId);
    setDraft(newDevProject({ mode: 'plan' }));
  }

  function prepareTask() {
    if (!brief.trim() || !project) return;
    // Garante que o rascunho vire projeto persistido antes de iniciar.
    let proj = project;
    if (isDraft) {
      proj = createProject({ ...draft, name: draft.name.trim() || 'Projeto sem nome' });
      setDraft(null);
    }
    onStart({
      devProjectId: proj.id,
      mode: proj.mode,
      binding: proj.binding,
      brief: brief.trim()
    });
  }

  const memoryFilled = useMemo(
    () => Object.values(project?.memory || {}).filter(v => (v || '').trim()).length,
    [project]
  );

  return <Drawer title="Modo desenvolvedor" icon={<Code2 size={18}/>} onClose={onClose} className="developerDrawer">
    {/* ── Projeto ───────────────────────────────────────────────── */}
    <div className="devField">
      <div className="devFieldHead">
        <span><FolderGit2 size={14}/> Projeto</span>
        <button type="button" className="devFolderButton" onClick={onManageFolders} title="Gerenciar pastas do computador" aria-label="Gerenciar pastas do computador"><FolderCog size={16}/></button>
      </div>
      <div className="devProjectRow">
        <select value={isDraft ? '__new__' : activeId} onChange={e => selectProject(e.target.value)}>
          <option value="__new__">＋ Novo projeto</option>
          {projects.length > 0 && <optgroup label="Meus projetos">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name || 'Projeto sem nome'}</option>)}
          </optgroup>}
        </select>
        {!isDraft && <button type="button" className="devIconBtn danger" onClick={removeProject} title="Excluir projeto" aria-label="Excluir projeto"><Trash2 size={15}/></button>}
      </div>
      <input className="devText" value={project?.name || ''} onChange={e => patch({ name: e.target.value })} placeholder="Nome do projeto (ex.: Portal do Cliente)"/>
      <input className="devText" value={project?.description || ''} onChange={e => patch({ description: e.target.value })} placeholder="Descrição curta do que o projeto faz"/>
      <input className="devText" value={project?.techs || ''} onChange={e => patch({ techs: e.target.value })} placeholder="Linguagens e tecnologias (ex.: Node, React, PostgreSQL)"/>
    </div>

    {/* ── Vínculo (pasta ou repositório) ────────────────────────── */}
    <div className="devField">
      <div className="devFieldHead"><span><FolderOpen size={14}/> Pasta ou repositório</span></div>
      <select value={bindingValue} onChange={e => changeBinding(e.target.value)} disabled={folders === null && githubRepos === null}>
        <option value="">Nenhum (usar arquivos da conversa)</option>
        {(folders || []).length > 0 && <optgroup label="Pastas do computador">
          {(folders || []).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </optgroup>}
        {(githubRepos || []).length > 0 && <optgroup label="GitHub">
          {(githubRepos || []).map(r => <option key={r.full_name} value={`${GITHUB_PREFIX}${r.full_name}`}>{r.full_name}{r.private ? ' (privado)' : ''}</option>)}
        </optgroup>}
      </select>
      {folder && <div className="devProjectStatus">
        <FolderOpen size={15}/><span title={folder.host_path}>{folder.host_path}</span>
        <b className={canWriteProject ? 'write' : 'read'}>{canWriteProject ? <Unlock size={13}/> : <Lock size={13}/>}{canWriteProject ? 'Escrita' : 'Leitura'}</b>
      </div>}
      {githubRepoName && <div className="devProjectStatus">
        <GitHubIcon size={15}/><span title={githubRepoName}>{githubRepoName}</span>
        <b className={canWriteProject ? 'write' : 'read'}>{canWriteProject ? <Unlock size={13}/> : <Lock size={13}/>}{canWriteProject ? 'Pode enviar (push)' : 'Só leitura'}</b>
      </div>}
      {!githubConnected && githubRepos !== null && <div className="muted small" style={{ marginTop: 2 }}>
        Quer trabalhar num repositório GitHub? <button type="button" className="linklike" onClick={onOpenConnectors}>Conecte a sua conta</button>.
      </div>}
    </div>

    {githubRepoName && <div className="devField">
      <div className="devFieldHead"><span><GitBranch size={14}/> Branch</span></div>
      {branches === null
        ? <div className="working"><span className="spin"/><span>Carregando branches...</span></div>
        : <select value={binding.branch || ''} onChange={e => patch({ binding: { ...binding, branch: e.target.value } })}>
            {branches.length === 0 && binding.branch && <option value={binding.branch}>{binding.branch}</option>}
            {branches.map(name => <option key={name} value={name}>{name}{name === githubRepo?.default_branch ? ' (padrão)' : ''}</option>)}
          </select>}
      {mode.write && <p className="muted small" style={{ margin: '2px 0 0' }}>As mudanças vão para esta branch. Prefere não mexer na principal? Peça na missão (ex.: "crie uma branch ajuste-login e abra um Pull Request").</p>}
    </div>}

    {/* ── Modo de trabalho ──────────────────────────────────────── */}
    <div className="devField">
      <div className="devFieldHead"><span>Modo de trabalho</span></div>
      <div className="devModeGrid" role="radiogroup" aria-label="Modo de trabalho">
        {DEV_WORK_MODES.map(m => {
          const Icon = DEV_MODE_ICON[m.id] || Code2;
          const sel = m.id === mode.id;
          return <button key={m.id} type="button" role="radio" aria-checked={sel} className={`devModeCard ${sel ? 'sel' : ''}`} onClick={() => patch({ mode: m.id })}>
            <span className="devModeCardTop"><Icon size={15}/><b>{m.label}</b><span className={`devModeTag ${m.write ? 'write' : 'read'}`}>{m.write ? 'Edita' : 'Leitura'}</span></span>
            <small>{m.short}</small>
          </button>;
        })}
      </div>
    </div>

    {/* ── Missão ────────────────────────────────────────────────── */}
    <label className="devBrief">Missão
      <textarea value={brief} onChange={e => setBrief(e.target.value)} placeholder="Ex.: corrigir o fluxo de login sem mudar a interface" rows={4}/>
    </label>

    {/* ── Regras & memória do projeto ───────────────────────────── */}
    <details className="devRules">
      <summary><BookOpen size={15}/> Regras e memória do projeto{memoryFilled > 0 ? ` · ${memoryFilled} anotação${memoryFilled > 1 ? 'es' : ''}` : ''}</summary>
      <p className="muted small" style={{ margin: '0 0 8px' }}>Fica salvo no projeto e vai junto em toda conversa dele — a IA lembra sem você reexplicar.</p>
      <textarea value={project?.rules || ''} onChange={e => patch({ rules: e.target.value })} placeholder="Regras (ex.: manter a API pública; não adicionar dependências)" rows={3}/>
    </details>

    {/* ── Fluxo + ação ──────────────────────────────────────────── */}
    <div className="devFlow" aria-label={`Fluxo para ${mode.label.toLowerCase()}`}>
      {mode.steps.map((step, i) => <React.Fragment key={step}>
        <span>{i + 1}. {step}</span>{i < mode.steps.length - 1 && <ArrowRight size={14}/>}
      </React.Fragment>)}
    </div>

    <div className="devActionRow">
      <span className="devModeBadge">{(() => { const Icon = DEV_MODE_ICON[mode.id] || Code2; return <Icon size={14}/>; })()}{mode.label}</span>
      <button type="button" className="primary" onClick={prepareTask} disabled={!brief.trim() || !project}><ArrowRight size={16}/> Abrir tarefa</button>
    </div>
  </Drawer>;
}
