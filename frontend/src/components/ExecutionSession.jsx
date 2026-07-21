import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Terminal, FolderOpen, Globe, Search, Image as ImageIcon, FileCog,
  X, Maximize2, CheckCircle2, AlertCircle, Circle, Cpu,
  Loader
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Ambiente de Trabalho da IA
//
// Em vez de despejar dezenas de cartões "bash 0s" no chat, todas as chamadas de
// ferramenta de uma resposta são agrupadas numa ÚNICA sessão de execução. Ela
// aparece como um cartão compacto na conversa e pode ser expandida para uma
// janela ao vivo (terminal, arquivos, código, pesquisa, navegador) onde o
// usuário acompanha o que a IA está fazendo, com as etapas humanizadas.
// ─────────────────────────────────────────────────────────────────────────────

// Cada ferramenta do backend vira uma "etapa" com nome humano e categoria.
const TOOL_META = {
  bash:           { cat: 'terminal', running: 'Executando comando no terminal', done: 'Comando no terminal' },
  run_python:     { cat: 'terminal', running: 'Executando código Python',        done: 'Código Python executado' },
  write_file:     { cat: 'code',     running: 'Criando ou alterando arquivo',     done: 'Arquivo criado ou alterado' },
  read_file:      { cat: 'files',    running: 'Lendo arquivo',                    done: 'Arquivo analisado' },
  list_files:     { cat: 'files',    running: 'Listando arquivos',                done: 'Arquivos listados' },
  zip_outputs:    { cat: 'files',    running: 'Compactando arquivos',             done: 'Arquivos compactados' },
  web_search:     { cat: 'search',   running: 'Pesquisando na internet',          done: 'Pesquisa na internet' },
  web_fetch:      { cat: 'browser',  running: 'Abrindo página no navegador',      done: 'Página aberta no navegador' },
  generate_image: { cat: 'image',    running: 'Gerando imagem',                   done: 'Imagem gerada' },
  consultar_cnpj: { cat: 'search',   running: 'Consultando CNPJ',                 done: 'CNPJ consultado' }
};

const CAT_META = {
  terminal: { Icon: Terminal,   label: 'Terminal',  inputLabel: 'Comando' },
  code:     { Icon: FileCog,    label: 'Código',    inputLabel: 'Arquivo' },
  files:    { Icon: FolderOpen, label: 'Arquivos',  inputLabel: 'Arquivo' },
  search:   { Icon: Search,     label: 'Pesquisa',  inputLabel: 'Consulta' },
  browser:  { Icon: Globe,      label: 'Navegador', inputLabel: 'Endereço' },
  image:    { Icon: ImageIcon,  label: 'Imagem',    inputLabel: 'Descrição' },
  other:    { Icon: Cpu,        label: 'Ações',     inputLabel: 'Entrada' }
};

const metaOf = name => TOOL_META[name] || { cat: 'other', running: `Executando ${name}`, done: name };

function describe(step) {
  const meta = metaOf(step.name);
  const cat = CAT_META[meta.cat] || CAT_META.other;
  const label = step.status === 'running' ? meta.running : meta.done;
  return { cat: meta.cat, catMeta: cat, label, detail: (step.preview || '').trim() };
}

const fmtDuration = ms => {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}min ${s}s` : `${m}min`;
};

// Contagens usadas no cartão compacto e no resumo final.
function summarize(steps, now) {
  const count = name => steps.filter(s => s.name === name).length;
  const files = count('write_file') + count('zip_outputs') + count('generate_image');
  const commands = count('bash') + count('run_python');
  const searches = count('web_search') + count('web_fetch');
  const reads = count('read_file') + count('list_files');
  const errors = steps.filter(s => s.status === 'error').length;
  const starts = steps.map(s => s.started).filter(Boolean);
  const ends = steps.map(s => s.ended).filter(Boolean);
  const first = starts.length ? Math.min(...starts) : now;
  const last = steps.some(s => s.status === 'running') || !ends.length ? now : Math.max(...ends);
  return { total: steps.length, files, commands, searches, reads, errors, elapsed: fmtDuration(last - first) };
}

// Frase-resumo montada a partir das categorias presentes (sem inventar nada).
function summaryPhrase(s) {
  const parts = [];
  if (s.searches) parts.push('pesquisando na internet');
  if (s.reads) parts.push('analisando arquivos');
  if (s.commands) parts.push('executando comandos');
  if (s.files) parts.push('gerando arquivos');
  if (!parts.length) return 'Preparando o trabalho';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function statusIcon(status) {
  if (status === 'running') return <Loader size={15} className="esSpin" />;
  if (status === 'error') return <AlertCircle size={15} className="esErr" />;
  return <CheckCircle2 size={15} className="esOk" />;
}

// ─── Janela ao vivo (overlay em tela cheia) ─────────────────────────────────
function WorkspaceOverlay({ steps, live, sum, onClose }) {
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [follow, setFollow] = useState(true);
  const listRef = useRef(null);

  // Enquanto a IA trabalha, acompanha automaticamente a última etapa —
  // até o usuário clicar em alguma, quando o acompanhamento é pausado.
  useEffect(() => {
    if (!follow) return;
    const runningIdx = steps.findIndex(s => s.status === 'running');
    const idx = runningIdx > -1 ? runningIdx : steps.length - 1;
    setSelected(idx);
  }, [steps, follow]);

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [steps.length, follow]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  const cats = useMemo(() => {
    const present = new Set(steps.map(s => metaOf(s.name).cat));
    return ['all', ...Object.keys(CAT_META).filter(c => present.has(c))];
  }, [steps]);

  const visible = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => filter === 'all' || metaOf(s.name).cat === filter);

  const active = selected != null ? steps[selected] : null;
  const activeInfo = active ? describe(active) : null;
  const running = steps.find(s => s.status === 'running');
  const runningInfo = running ? describe(running) : null;

  function pick(i) { setFollow(false); setSelected(i); }

  return (
    <div className="esOverlay" role="dialog" aria-modal="true" aria-label="Ambiente de Trabalho da IA" onMouseDown={onClose}>
      <div className="esWindow" onMouseDown={e => e.stopPropagation()}>
        <header className="esWinHead">
          <div className="esWinTitle">
            <span className="esWinDot">{live ? <Loader size={16} className="esSpin" /> : <CheckCircle2 size={16} className="esOk" />}</span>
            <div>
              <b>Ambiente de Trabalho da IA</b>
              <small>{live ? (runningInfo ? `Etapa atual: ${runningInfo.label}` : 'Trabalhando…') : 'Execução concluída'}</small>
            </div>
          </div>
          <button className="esWinClose" onClick={onClose} title="Minimizar (voltar ao chat)" aria-label="Minimizar">
            <X size={18} />
          </button>
        </header>

        <div className="esWinStats">
          <span><b>{sum.total}</b> etapas</span>
          {sum.reads > 0 && <span><b>{sum.reads}</b> leituras</span>}
          {sum.commands > 0 && <span><b>{sum.commands}</b> comandos</span>}
          {sum.searches > 0 && <span><b>{sum.searches}</b> pesquisas</span>}
          {sum.files > 0 && <span><b>{sum.files}</b> arquivos</span>}
          <span className={sum.errors ? 'esStatErr' : ''}><b>{sum.errors}</b> {sum.errors === 1 ? 'erro' : 'erros'}</span>
          <span className="esWinTime">{sum.elapsed}</span>
        </div>

        {cats.length > 2 && (
          <div className="esFilters" role="tablist" aria-label="Filtrar etapas por tipo">
            {cats.map(c => {
              const label = c === 'all' ? 'Tudo' : CAT_META[c].label;
              return (
                <button key={c} role="tab" aria-selected={filter === c} className={filter === c ? 'on' : ''} onClick={() => setFilter(c)}>
                  {label}
                </button>
              );
            })}
          </div>
        )}

        <div className="esWinBody">
          <ol className="esSteps" ref={listRef}>
            {visible.map(({ s, i }) => {
              const info = describe(s);
              const CatIcon = info.catMeta.Icon;
              return (
                <li key={i}>
                  <button className={`esStep ${s.status} ${selected === i ? 'sel' : ''}`} onClick={() => pick(i)}>
                    <span className="esStepStat">{statusIcon(s.status)}</span>
                    <span className="esStepCat"><CatIcon size={14} /></span>
                    <span className="esStepText">
                      <b>{info.label}</b>
                      {info.detail && <small>{info.detail}</small>}
                    </span>
                  </button>
                </li>
              );
            })}
            {live && (
              <li className="esNext">
                <Circle size={13} /> <span>Preparando próxima etapa…</span>
              </li>
            )}
          </ol>

          <div className="esDetail">
            {active ? (
              <>
                <div className="esDetailHead">
                  <activeInfo.catMeta.Icon size={16} />
                  <b>{activeInfo.label}</b>
                  <span className="esDetailBadge">{activeInfo.catMeta.label}</span>
                </div>
                {activeInfo.detail && (
                  <div className="esBlock">
                    <span className="esBlockLabel">{activeInfo.catMeta.inputLabel}</span>
                    <pre className="esInput">{activeInfo.detail}</pre>
                  </div>
                )}
                <div className="esBlock">
                  <span className="esBlockLabel">Resultado</span>
                  {active.status === 'running'
                    ? <div className="esWaiting"><Loader size={14} className="esSpin" /> Executando…</div>
                    : <pre className={`esOutput ${active.status === 'error' ? 'err' : ''}`}>{active.result || '(sem saída)'}</pre>}
                </div>
              </>
            ) : (
              <div className="esEmpty">Selecione uma etapa para ver os detalhes.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Cartão compacto no chat ────────────────────────────────────────────────
export function ExecutionSession({ steps, live, nowTick }) {
  const [open, setOpen] = useState(false);
  // Relógio próprio: mantém o tempo "vivo" mesmo quando o pai não re-renderiza.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  const now = Date.now();
  const sum = useMemo(() => summarize(steps, now), [steps, now, nowTick]);
  if (!steps.length) return null;

  const running = steps.find(s => s.status === 'running');
  const runningInfo = running ? describe(running) : null;
  const hasError = sum.errors > 0;

  const title = live ? 'IA trabalhando no projeto' : (hasError ? 'Tarefa concluída com avisos' : 'Tarefa concluída');
  const subtitle = live
    ? (runningInfo ? runningInfo.label : summaryPhrase(sum))
    : summaryPhrase(sum);

  const chips = [];
  if (!live) {
    if (sum.files) chips.push(`${sum.files} ${sum.files === 1 ? 'arquivo' : 'arquivos'}`);
    if (sum.commands) chips.push(`${sum.commands} ${sum.commands === 1 ? 'comando' : 'comandos'}`);
    if (sum.searches) chips.push(`${sum.searches} ${sum.searches === 1 ? 'pesquisa' : 'pesquisas'}`);
    chips.push(hasError ? `${sum.errors} ${sum.errors === 1 ? 'erro' : 'erros'}` : 'nenhum erro');
  } else {
    chips.push(`${sum.total} ${sum.total === 1 ? 'etapa' : 'etapas'}`);
    if (sum.files) chips.push(`${sum.files} ${sum.files === 1 ? 'arquivo' : 'arquivos'}`);
  }

  return (
    <div className={`esCard ${live ? 'live' : (hasError ? 'warn' : 'done')}`}>
      <div className="esCardMain">
        <span className="esCardIcon">
          {live ? <Loader size={18} className="esSpin" /> : (hasError ? <AlertCircle size={18} className="esErr" /> : <CheckCircle2 size={18} className="esOk" />)}
        </span>
        <div className="esCardText">
          <b>{title}</b>
          <span className="esCardSub">{subtitle}</span>
          <span className="esCardMeta">{chips.join(' · ')} · {sum.elapsed}</span>
        </div>
      </div>
      <button className="esCardBtn" onClick={() => setOpen(true)}>
        <Maximize2 size={14} />
        {live ? 'Abrir ambiente de trabalho' : 'Ver detalhes'}
      </button>
      {open && <WorkspaceOverlay steps={steps} live={live} sum={sum} onClose={() => setOpen(false)} />}
    </div>
  );
}
