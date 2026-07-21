import React, { useMemo, useState } from 'react';
import {
  Activity, Brain, PanelRightClose, PanelRightOpen, Loader, CheckCircle2, AlertCircle,
  Terminal, FileCog, FolderOpen, Search, ShieldCheck, ChevronDown
} from 'lucide-react';
import { MEMORY_FIELDS } from '../hooks/useDevProjects.js';

// Painel de atividades e memória (coluna direita do ambiente).
// Mostra, em tempo real, o que a IA está fazendo na última resposta (etapas,
// contagens, status) e concentra a "memória permanente" do projeto — editável
// e persistida, para a IA não precisar reaprender o contexto a cada conversa.

const COUNTERS = [
  { key: 'reads',    label: 'leituras',  Icon: FolderOpen, names: ['read_file', 'list_files'] },
  { key: 'commands', label: 'comandos',  Icon: Terminal,   names: ['bash', 'run_python'] },
  { key: 'files',    label: 'arquivos',  Icon: FileCog,    names: ['write_file', 'zip_outputs', 'generate_image'] },
  { key: 'searches', label: 'pesquisas', Icon: Search,     names: ['web_search', 'web_fetch'] }
];

function useActivity(messages) {
  return useMemo(() => {
    const lastAssistant = [...(messages || [])].reverse().find(m => m.role === 'assistant' && Array.isArray(m.blocks));
    const steps = (lastAssistant?.blocks || []).filter(b => b.type === 'tool');
    const running = steps.some(s => s.status === 'running');
    const errors = steps.filter(s => s.status === 'error').length;
    const counts = COUNTERS.map(c => ({ ...c, n: steps.filter(s => c.names.includes(s.name)).length })).filter(c => c.n > 0);
    return { steps, running, errors, counts, total: steps.length };
  }, [messages]);
}

export function DevActivityRail({ collapsed, onToggle, busy, statusText, messages, project, onUpdateMemory }) {
  const act = useActivity(messages);
  const [openMemory, setOpenMemory] = useState(true);

  if (collapsed) {
    return <aside className="devRail devRailRight collapsed">
      <button className="devRailExpand" onClick={onToggle} title="Mostrar atividades" aria-label="Mostrar atividades"><PanelRightOpen size={17}/></button>
      <span className="devRailStripLabel">Atividade</span>
    </aside>;
  }

  const live = busy || act.running;
  return <aside className="devRail devRailRight" aria-label="Atividades e memória do projeto">
    <div className="devRailHead">
      <span><Activity size={15}/> Atividade</span>
      <button className="devRailCollapse" onClick={onToggle} title="Recolher" aria-label="Recolher o painel"><PanelRightClose size={16}/></button>
    </div>

    <div className="devRailScroll">
      <div className="devRailSection">
        <div className={`devActStatus ${live ? 'live' : (act.errors ? 'warn' : (act.total ? 'done' : 'idle'))}`}>
          <span className="devActIcon">
            {live ? <Loader size={16} className="esSpin"/> : (act.errors ? <AlertCircle size={16}/> : (act.total ? <CheckCircle2 size={16}/> : <Activity size={16}/>))}
          </span>
          <div>
            <b>{live ? 'IA trabalhando no projeto' : (act.total ? (act.errors ? 'Concluído com avisos' : 'Tarefa concluída') : 'Pronto para começar')}</b>
            <small>{live ? (statusText || 'Executando…') : (act.total ? `${act.total} etapa${act.total > 1 ? 's' : ''} na última resposta` : 'Envie uma missão para começar')}</small>
          </div>
        </div>
        {act.counts.length > 0 && <div className="devActCounts">
          {act.counts.map(c => <span key={c.key}><c.Icon size={13}/> <b>{c.n}</b> {c.label}</span>)}
          {act.errors > 0 && <span className="err"><AlertCircle size={13}/> <b>{act.errors}</b> {act.errors > 1 ? 'erros' : 'erro'}</span>}
        </div>}
        {act.total > 0 && <p className="devRailHint"><ShieldCheck size={12}/> Abra "Ambiente de Trabalho da IA" na resposta para ver comandos e logos completos.</p>}
      </div>

      {project && <div className="devRailSection">
        <button className="devMemoryToggle" onClick={() => setOpenMemory(o => !o)} aria-expanded={openMemory}>
          <span><Brain size={14}/> Memória do projeto</span>
          <ChevronDown size={15} className={openMemory ? 'open' : ''}/>
        </button>
        {openMemory && <div className="devMemory">
          <p className="devRailHint">Pertence ao projeto e acompanha toda conversa dele. Preencha o que a IA deve sempre lembrar.</p>
          {MEMORY_FIELDS.map(f => <label key={f.key} className="devMemoryField">
            <span>{f.label}</span>
            <textarea
              value={project.memory?.[f.key] || ''}
              onChange={e => onUpdateMemory(f.key, e.target.value)}
              placeholder="—"
              rows={2}
            />
          </label>)}
        </div>}
      </div>}

      {!project && <div className="devRailSection">
        <p className="devRailEmpty">Nenhum projeto ativo. Crie um projeto para guardar a memória permanente (arquitetura, decisões, padrões, pendências).</p>
      </div>}
    </div>
  </aside>;
}
