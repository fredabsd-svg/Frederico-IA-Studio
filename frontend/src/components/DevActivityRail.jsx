import React, { useMemo, useState } from 'react';
import {
  Activity, Brain, PanelRightClose, PanelRightOpen, Loader, CheckCircle2, AlertCircle,
  Terminal, FileCog, FolderOpen, Search, ShieldCheck, ChevronDown, FileText, ListTree, GitCompareArrows
} from 'lucide-react';
import { MEMORY_FIELDS } from '../hooks/useDevProjects.js';
import { describe, statusIcon, tryParse } from './ExecutionSession.jsx';

// Painel de atividades, arquivos, alterações e memória do Modo Desenvolvedor
// (coluna direita do ambiente). Quatro abas sobre a MESMA fonte de dados — os
// passos de ferramenta da última resposta do assistente — mais a memória
// permanente do projeto, editável.

const COUNTERS = [
  { key: 'reads',    label: 'leituras',  Icon: FolderOpen, names: ['read_file', 'list_files'] },
  { key: 'commands', label: 'comandos',  Icon: Terminal,   names: ['bash', 'run_python'] },
  { key: 'files',    label: 'arquivos',  Icon: FileCog,    names: ['write_file', 'zip_outputs', 'generate_image'] },
  { key: 'searches', label: 'pesquisas', Icon: Search,     names: ['web_search', 'web_fetch'] }
];

const TABS = [
  { id: 'atividade', label: 'Atividade', Icon: Activity },
  { id: 'arquivos', label: 'Arquivos', Icon: FolderOpen },
  { id: 'alteracoes', label: 'Alterações', Icon: GitCompareArrows },
  { id: 'memoria', label: 'Memória', Icon: Brain }
];

function useActivity(messages) {
  return useMemo(() => {
    const lastAssistant = [...(messages || [])].reverse().find(m => m.role === 'assistant');
    const steps = (lastAssistant?.blocks || []).filter(b => b.type === 'tool');
    const running = steps.some(s => s.status === 'running');
    const errors = steps.filter(s => s.status === 'error').length;
    const counts = COUNTERS.map(c => ({ ...c, n: steps.filter(s => c.names.includes(s.name)).length })).filter(c => c.n > 0);
    return { steps, running, errors, counts, total: steps.length, execution: lastAssistant?.execution || null, failed: Boolean(lastAssistant?.failed), resumable: Boolean(lastAssistant?.resumable) };
  }, [messages]);
}

const LIVE_STATES = new Set(['waiting', 'planning', 'analyzing', 'tool_running', 'tool_waiting', 'processing_result', 'continuing', 'validating']);
const STATE_LABELS = {
  completed: 'Tarefa concluída',
  awaiting_user: 'Aguardando sua resposta',
  paused: 'Tarefa pausada',
  stopped: 'Tarefa interrompida',
  recoverable_error: 'Interrompida, pode continuar',
  fatal_error: 'Não foi possível concluir'
};

// Agrupa chamadas CONSECUTIVAS da mesma ferramenta num só item ("3 comandos no
// terminal" em vez de 3 cartões soltos) — cada item guarda os passos originais
// para o detalhe, ao expandir.
function groupSteps(steps) {
  const groups = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && last.name === s.name) last.items.push(s);
    else groups.push({ name: s.name, items: [s] });
  }
  return groups;
}

// Deriva "arquivos analisados" (read_file/list_files) e "arquivos alterados"
// (write_file, com o path/tamanho REAIS devolvidos pela ferramenta — nunca
// inventamos contagem de linhas, já que o backend não devolve diff). O selo
// M/A é uma pista honesta: M se o mesmo caminho já apareceu numa leitura
// anterior nesta resposta, A caso contrário — não é um git diff de verdade.
function buildFileTabs(steps) {
  const seenPaths = new Set();
  const analyzedMap = new Map();
  const changed = [];
  for (const s of steps) {
    if (s.name === 'read_file') {
      const p = (s.preview || '').trim();
      if (p) { seenPaths.add(p); analyzedMap.set(p, { path: p, status: s.status }); }
    } else if (s.name === 'list_files') {
      const parsed = tryParse(s.result);
      for (const p of (parsed?.files || [])) {
        seenPaths.add(p);
        if (!analyzedMap.has(p)) analyzedMap.set(p, { path: p, status: s.status, listed: true });
      }
    } else if (s.name === 'write_file') {
      const parsed = tryParse(s.result);
      const path = (parsed?.path || s.preview || '').trim();
      if (!path) continue;
      const badge = seenPaths.has(path) ? 'M' : 'A';
      changed.push({ path, size: parsed?.size, badge, status: s.status, error: s.status === 'error' ? (parsed?.error || 'Falhou') : null });
      seenPaths.add(path);
    }
  }
  return { analyzed: [...analyzedMap.values()], changed };
}

function ActivityList({ steps }) {
  const groups = useMemo(() => groupSteps(steps), [steps]);
  const [openIdx, setOpenIdx] = useState(null);
  if (!steps.length) return <div className="devRailEmpty"><Activity size={22}/><p>Pronto para começar. Envie uma missão para ver o passo a passo aqui.</p></div>;
  return <ol className="devActList">
    {groups.map((g, i) => {
      const last = g.items[g.items.length - 1];
      const info = describe(last);
      const CatIcon = info.catMeta.Icon;
      const status = g.items.some(s => s.status === 'running') ? 'running' : (g.items.some(s => s.status === 'error') ? 'error' : 'done');
      const multi = g.items.length > 1;
      const open = openIdx === i;
      return <li key={i} className="devActGroup">
        <button className={`devActItem ${status}`} onClick={() => multi && setOpenIdx(open ? null : i)} disabled={!multi && !info.detail}>
          <span className="devActItemIc">{statusIcon(status)}</span>
          <span className="devActItemCat"><CatIcon size={13}/></span>
          <span className="devActItemText">
            <b>{multi ? `${g.items.length}× ${info.label}` : info.label}</b>
            {!multi && info.detail && <small>{info.detail}</small>}
          </span>
          {multi && <ChevronDown size={14} className={`devActChev ${open ? 'up' : ''}`}/>}
        </button>
        {multi && open && <ul className="devActSub">
          {g.items.map((s, j) => {
            const sub = describe(s);
            return <li key={j}>
              <span className="devActItemIc">{statusIcon(s.status)}</span>
              <span className="devActItemText"><b>{sub.label}</b>{sub.detail && <small>{sub.detail}</small>}</span>
            </li>;
          })}
        </ul>}
      </li>;
    })}
  </ol>;
}

function FilesTab({ steps, downloadUrl }) {
  const { analyzed } = useMemo(() => buildFileTabs(steps), [steps]);
  if (!analyzed.length) return <div className="devRailEmpty"><ListTree size={22}/><p>Os arquivos que a IA ler ou listar durante a tarefa aparecem aqui.</p></div>;
  return <ul className="devFileList">
    {analyzed.map((f, i) => <li key={`${f.path}-${i}`}>
      <a className="devFileItem" href={downloadUrl(f.path)} target="_blank" rel="noreferrer" title={`${f.path} — abrir`}>
        <FileText size={14}/>
        <span className="devFileName">{f.path}</span>
        <span className="devFileKind">{f.listed ? 'listado' : 'lido'}</span>
      </a>
    </li>)}
  </ul>;
}

function ChangesTab({ steps, downloadUrl }) {
  const { changed } = useMemo(() => buildFileTabs(steps), [steps]);
  if (!changed.length) return <div className="devRailEmpty"><GitCompareArrows size={22}/><p>Nenhuma alteração ainda. Os arquivos criados ou editados pela IA aparecem aqui.</p></div>;
  return <ul className="devFileList devChangeList">
    {changed.map((f, i) => <li key={`${f.path}-${i}`}>
      {f.error
        ? <span className="devFileItem devFileError" title={f.error}><span className={`devBadge ${f.badge === 'A' ? 'add' : 'mod'}`}>{f.badge}</span><span className="devFileName">{f.path}</span><small>falhou</small></span>
        : <a className="devFileItem" href={downloadUrl(f.path)} target="_blank" rel="noreferrer" title={`${f.path} — abrir`}>
            <span className={`devBadge ${f.badge === 'A' ? 'add' : 'mod'}`}>{f.badge}</span>
            <span className="devFileName">{f.path}</span>
            {f.size != null && <span className="devFileKind">{Math.ceil(f.size / 1024) || 1} KB</span>}
          </a>}
    </li>)}
  </ul>;
}

export function DevActivityRail({ collapsed, onToggle, busy, statusText, messages, project, onUpdateMemory, downloadUrl }) {
  const act = useActivity(messages);
  const [tab, setTab] = useState('atividade');
  const dlUrl = downloadUrl || (() => '#');

  if (collapsed) {
    return <aside className="devRail devRailRight collapsed">
      <button className="devRailExpand" onClick={onToggle} title="Mostrar o painel" aria-label="Mostrar o painel"><PanelRightOpen size={17}/></button>
      <span className="devRailStripLabel">Atividade</span>
    </aside>;
  }

  const state = act.execution?.state;
  const live = busy || act.running || LIVE_STATES.has(state);
  const failed = act.failed || ['stopped', 'recoverable_error', 'fatal_error'].includes(state);
  const resultLabel = STATE_LABELS[state]
    || (act.resumable ? 'Interrompida, pode continuar' : (failed ? 'Não foi possível concluir' : (act.total ? 'Etapas registradas' : 'Pronto para começar')));

  return <aside className="devRail devRailRight" aria-label="Atividade, arquivos, alterações e memória do projeto">
    <div className="devRailHead">
      <span><Activity size={15}/> Ambiente de trabalho</span>
      <button className="devRailCollapse" onClick={onToggle} title="Recolher" aria-label="Recolher o painel"><PanelRightClose size={16}/></button>
    </div>

    <div className="devTabs" role="tablist" aria-label="Seções do ambiente de trabalho">
      {TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`devTab ${tab === t.id ? 'sel' : ''}`} onClick={() => setTab(t.id)}>
        <t.Icon size={13}/><span>{t.label}</span>
      </button>)}
    </div>

    <div className="devRailScroll">
      {tab === 'atividade' && <div className="devRailSection">
        <div className={`devActStatus ${live ? 'live' : ((act.errors || failed || act.resumable) ? 'warn' : (state === 'completed' ? 'done' : 'idle'))}`}>
          <span className="devActIcon">
            {live ? <Loader size={16} className="esSpin"/> : ((act.errors || failed || act.resumable) ? <AlertCircle size={16}/> : (state === 'completed' ? <CheckCircle2 size={16}/> : <Activity size={16}/>))}
          </span>
          <div>
            <b>{live ? 'IA trabalhando no projeto' : resultLabel}</b>
            <small>{live ? (statusText || act.execution?.detail || 'Executando…') : (act.execution?.detail || (act.total ? `${act.total} etapa${act.total > 1 ? 's' : ''} na última resposta` : 'Envie uma missão para começar'))}</small>
          </div>
        </div>
        {act.counts.length > 0 && <div className="devActCounts">
          {act.counts.map(c => <span key={c.key}><c.Icon size={13}/> <b>{c.n}</b> {c.label}</span>)}
          {act.errors > 0 && <span className="err"><AlertCircle size={13}/> <b>{act.errors}</b> {act.errors > 1 ? 'erros' : 'erro'}</span>}
        </div>}
        <ActivityList steps={act.steps}/>
      </div>}

      {tab === 'arquivos' && <div className="devRailSection">
        <label className="devRailLabel">Arquivos analisados</label>
        <FilesTab steps={act.steps} downloadUrl={dlUrl}/>
      </div>}

      {tab === 'alteracoes' && <div className="devRailSection">
        <label className="devRailLabel">Arquivos alterados</label>
        <ChangesTab steps={act.steps} downloadUrl={dlUrl}/>
      </div>}

      {tab === 'memoria' && <div className="devRailSection">
        {project ? <>
          <p className="devRailHint">Pertence ao projeto e acompanha toda conversa dele. Preencha o que a IA deve sempre lembrar.</p>
          <div className="devMemory">
            {MEMORY_FIELDS.map(f => <label key={f.key} className="devMemoryField">
              <span>{f.label}</span>
              <textarea
                value={project.memory?.[f.key] || ''}
                onChange={e => onUpdateMemory(f.key, e.target.value)}
                placeholder="—"
                rows={2}
              />
            </label>)}
          </div>
        </> : <p className="devRailEmpty">Nenhum projeto ativo. Crie um projeto para guardar a memória permanente (arquitetura, decisões, padrões, pendências).</p>}
      </div>}
    </div>
  </aside>;
}
