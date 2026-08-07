import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, BookOpen, Code2, FolderCog, FolderOpen, GitBranch, Lock, Unlock, Info,
  ShieldCheck, Plus, Trash2, FolderGit2
} from 'lucide-react';
import { API, DEV_WORK_MODES } from './constants.js';
import { Drawer, useAppDialog } from './components.jsx';
import { GitHubIcon } from './ConnectorsPanel.jsx';
import { githubWritePermissionFor, newDevProject } from './hooks/useDevProjects.js';
// Ícones dos modos: módulo compartilhado (ver devModeIcons.js) para o import
// estático do DevProjectRail não puxar este drawer para o chunk de entrada.
import { DEV_MODE_ICON } from './devModeIcons.js';

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

// Rótulos dos motivos de bloqueio da publicação. Espelham o enum do backend
// (`agent/githubAccess.js` → GITHUB_BLOCK_REASONS). O backend também manda a
// frase pronta em `blockingMessage`; esta tabela é o fallback quando o pré-voo
// ainda não respondeu — e a garantia de que a interface nunca cai num genérico
// "a ferramenta não está habilitada".
const BLOCK_LABEL = {
  github_not_connected: 'GitHub não conectado — conecte a conta em Configurações → Conectores.',
  repository_not_bound: 'Nenhum repositório vinculado a este projeto.',
  read_only_mode: 'Modo somente leitura — escolha Implementar, Corrigir ou Autônomo para publicar.',
  write_not_confirmed: 'Publicação ainda não autorizada para esta branch.',
  invalid_branch: 'Selecione uma branch de trabalho válida.',
  scope_mismatch: 'A autorização registrada pertence a outro repositório, branch ou destino.',
  action_not_authorized: 'As ações autorizadas não incluem publicar e abrir Pull Request.',
  subagent_not_allowed: 'Sub-agentes não publicam.',
  low_signal_turn: 'Turno conversacional — nenhuma ferramenta remota é oferecida.'
};

export function DeveloperPanel({ devProjects, onStart, onManageFolders, onOpenConnectors, onClose, initialMode, team = false }) {
  const { projects, active, activeId, setActiveId, createProject, updateProject, deleteProject, authorizeGithubWrite, revokeGithubWrite } = devProjects;

  const [folders, setFolders] = useState(null);
  const [githubRepos, setGithubRepos] = useState(null); // null = carregando; [] = sem conector/sem repos
  const [githubConnected, setGithubConnected] = useState(false);
  const [branches, setBranches] = useState(null);
  const [brief, setBrief] = useState('');
  const [preflight, setPreflight] = useState(null); // estado REAL da publicação
  const { askConfirm, dialog: publishDialog } = useAppDialog();

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
  // Branch base (destino do Pull Request): a branch padrão do repositório.
  const baseBranch = githubRepo?.default_branch || 'main';
  // Autorização já registrada e AINDA VÁLIDA para o vínculo atual (mudar de
  // repositório, branch ou destino invalida — e a interface volta a pedir).
  const grant = githubWritePermissionFor(project, { base: baseBranch });
  // Branch de trabalho automática (decisão 2A): espelha a regra do backend
  // (agent/workBranch.js) só para EXPLICAR a configuração — quem decide de
  // fato é o pré-voo, na execução, onde a conversa já existe.
  const PROTEGIDAS = new Set(['main', 'master', 'develop', 'development', 'trunk', 'release', 'prod']);
  const trabalhoEmBranchPropria = canWriteProject && !!binding.branch && PROTEGIDAS.has(String(binding.branch).toLowerCase());

  // ── PRÉ-VOO DA PUBLICAÇÃO ─────────────────────────────────────────────────
  // A mesma função que o loop do agente usa para montar o inventário responde
  // aqui (GET /connectors/github/preflight). Antes, este painel mostrava "Pode
  // enviar (push)" só porque o modo era de escrita, enquanto o executor não
  // recebia `github_push` — a divergência que fazia o agente dizer que "a
  // ferramenta não está habilitada nesta sessão".
  useEffect(() => {
    if (!githubRepoName) { setPreflight(null); return undefined; }
    let alive = true;
    const params = new URLSearchParams({
      repo: githubRepoName,
      branch: binding.branch || '',
      base: baseBranch,
      mode: mode.id
    });
    if (grant) params.set('authorization', JSON.stringify(grant));
    (async () => {
      try {
        const data = await (await fetch(`${API}/api/connectors/github/preflight?${params}`)).json();
        if (alive) setPreflight(data && typeof data === 'object' ? data : null);
      } catch { if (alive) setPreflight(null); }
    })();
    return () => { alive = false; };
    // `grant` entra como string para o efeito não re-disparar por identidade de objeto.
  }, [githubRepoName, binding.branch, baseBranch, mode.id, JSON.stringify(grant)]);

  async function autorizarPublicacao() {
    if (!githubRepoName || !project?.id) return;
    // A confirmação MOSTRA o escopo exato — repositório, branch, destino e ações.
    const ok = await askConfirm({
      title: 'Autorizar publicação no GitHub',
      message: `Repositório: ${githubRepoName}\nBranch de trabalho: ${binding.branch || '(padrão do repositório)'}\nDestino do Pull Request: ${baseBranch}\nAções autorizadas: enviar (push) e abrir Pull Request\n\nA autorização vale só para este repositório e esta branch. Trocar de branch ou de repositório pede uma nova confirmação.`,
      confirmLabel: 'Autorizar publicação'
    });
    if (!ok) return;
    authorizeGithubWrite(project.id, { repo: githubRepoName, branch: binding.branch || '', base: baseBranch });
  }

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
        <b className={canWriteProject ? 'write' : 'read'}>{canWriteProject ? <Unlock size={13}/> : <Lock size={13}/>}{canWriteProject ? 'Modo escrita' : 'Só leitura'}</b>
      </div>}
      {githubRepoName && team && <div className="devTeamHint">
        <Info size={15}/>
        <span>Modo Equipe ativo: os especialistas do debate <b>analisam e orientam</b>, mas quem lê o código do repositório de fato é o executor, na etapa de execução. Para o modelo <b>ler os arquivos e responder direto</b>, desligue a Equipe e use um assistente único.</span>
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

    {/* ── Pré-voo da publicação ───────────────────────────────────────────────
        Cada condição aparece SEPARADA. Antes havia só um "Pode enviar (push)"
        derivado do modo — que dizia "sim" enquanto o executor não recebia
        `github_push`, e era daí que saía o "a ferramenta não está habilitada". */}
    {githubRepoName && <div className="devField">
      <div className="devFieldHead"><span><ShieldCheck size={14}/> Publicação</span></div>
      <ul className="devPreflight">
        <li className={preflight?.connected === false ? 'no' : 'yes'}>
          <span>GitHub</span><b>{preflight?.connected === false ? 'não conectado' : 'conectado'}</b>
        </li>
        <li className="yes"><span>Repositório</span><b>{githubRepoName}</b></li>
        <li className={binding.branch ? 'yes' : 'no'}><span>Branch</span><b>{binding.branch || 'nenhuma selecionada'}</b></li>
        {/* Branch de trabalho (decisão 2A): com o vínculo numa branch protegida
            e modo de escrita, a tarefa commita numa branch própria, criada a
            partir dela. O NOME exato depende da conversa (que ainda não
            existe aqui), então o painel anuncia a regra, não um nome falso. */}
        {trabalhoEmBranchPropria && <li className="yes">
          <span>Branch de trabalho</span><b>própria da tarefa (a partir de {binding.branch})</b>
        </li>}
        <li className="yes"><span>Destino do PR</span><b>{preflight?.base || baseBranch}</b></li>
        <li className={canWriteProject ? 'yes' : 'no'}><span>Modo</span><b>{canWriteProject ? 'escrita' : 'leitura'}</b></li>
        <li className={preflight?.writeAuthorized ? 'yes' : 'no'}>
          <span>Publicação</span><b>{preflight?.writeAuthorized ? 'autorizada' : 'não autorizada'}</b>
        </li>
        <li className={preflight?.tools?.push ? 'yes' : 'no'}>
          <span>Ferramentas</span>
          <b>{[
            preflight?.tools?.clone ? 'clone' : null,
            preflight?.tools?.push ? 'push' : null,
            preflight?.tools?.createPr ? 'Pull Request' : null
          ].filter(Boolean).join(', ') || 'nenhuma'}</b>
        </li>
      </ul>
      {/* Causa REAL do bloqueio, vinda do backend. */}
      {preflight && !preflight.writeAuthorized && <p className="devPreflightWhy">
        <Info size={14}/> <span>{preflight.blockingMessage || BLOCK_LABEL[preflight.blockingReason] || 'Publicação indisponível nesta configuração.'}</span>
      </p>}
      {preflight?.writeAuthorized
        ? <div className="devPreflightActions">
            <span className="devPreflightOk"><ShieldCheck size={14}/> Autorizado{grant?.githubWriteConfirmedAt ? ` em ${new Date(grant.githubWriteConfirmedAt).toLocaleString('pt-BR')}` : ''}</span>
            <button type="button" className="devIconBtn danger" onClick={() => revokeGithubWrite(project?.id)}>Revogar</button>
          </div>
        : trabalhoEmBranchPropria
        ? <p className="devPreflightWhy">
            <Info size={14}/>
            <span>Como o vínculo está numa branch protegida ({binding.branch}), a tarefa vai commitar numa <b>branch própria</b> criada a partir dela — e a autorização de publicação será pedida <b>dentro da tarefa</b>, já com o nome real dessa branch. Assim o que você autoriza é exatamente o que será publicado.</span>
          </p>
        : <div className="devPreflightActions">
            <button type="button" className="primary" onClick={autorizarPublicacao}
              disabled={isDraft || !canWriteProject || !binding.branch || preflight?.connected === false}
              title={isDraft
                ? 'Salve o projeto (abra uma tarefa) antes de autorizar a publicação'
                : 'Autoriza enviar a branch e abrir o Pull Request neste repositório'}>
              <ShieldCheck size={15}/> Autorizar publicação
            </button>
            {isDraft && <span className="muted small">Disponível depois de o projeto ser criado.</span>}
          </div>}
    </div>}
    {publishDialog}

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
