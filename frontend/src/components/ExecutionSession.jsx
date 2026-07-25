import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Terminal, FolderOpen, Globe, Search, Image as ImageIcon, FileCog,
  X, Maximize2, CheckCircle2, AlertCircle, Circle, Cpu, Loader, ExternalLink, Users
} from 'lucide-react';
import { API } from '../constants.js';
import { groupExecutionSteps, delegationSummary } from '../executionSteps.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ambiente de Trabalho da IA
//
// Em vez de despejar dezenas de cartões "bash 0s" no chat, todas as chamadas de
// ferramenta de uma resposta são agrupadas numa ÚNICA sessão de execução. Ela
// aparece como um cartão compacto na conversa e pode ser expandida para uma
// janela ao vivo (terminal, arquivos, código, pesquisa, navegador) onde o
// usuário acompanha o que a IA está fazendo, com as etapas humanizadas e o
// detalhe (entrada e resultado) de cada ação.
// ─────────────────────────────────────────────────────────────────────────────

// Cada ferramenta do backend vira uma "etapa" com nome humano e categoria.
// Exportado: reaproveitado pela aba Atividade do DevActivityRail, para os dois
// lugares mostrarem a mesma categoria/rótulo de cada ferramenta.
export const TOOL_META = {
  bash:           { cat: 'terminal', running: 'Executando comando no terminal', done: 'Comando no terminal' },
  run_python:     { cat: 'terminal', running: 'Executando código Python',        done: 'Código Python executado' },
  write_file:     { cat: 'code',     running: 'Criando ou alterando arquivo',     done: 'Arquivo criado ou alterado' },
  read_file:      { cat: 'files',    running: 'Lendo arquivo',                    done: 'Arquivo analisado' },
  list_files:     { cat: 'files',    running: 'Listando arquivos',                done: 'Arquivos listados' },
  zip_outputs:    { cat: 'files',    running: 'Compactando arquivos',             done: 'Arquivos compactados' },
  web_search:     { cat: 'search',   running: 'Pesquisando na internet',          done: 'Pesquisa na internet' },
  web_fetch:      { cat: 'browser',  running: 'Abrindo página no navegador',      done: 'Página aberta no navegador' },
  generate_image: { cat: 'image',    running: 'Gerando imagem',                   done: 'Imagem gerada' },
  consultar_cnpj: { cat: 'search',   running: 'Consultando CNPJ',                 done: 'CNPJ consultado' },
  delegar_subagente: { cat: 'agent', running: 'Sub-agente trabalhando',           done: 'Sub-agente concluiu' }
};

export { SUBAGENT_TOOL } from '../executionSteps.js';

export const CAT_META = {
  terminal: { Icon: Terminal,   label: 'Terminal',  inputLabel: 'Comando' },
  code:     { Icon: FileCog,    label: 'Código',    inputLabel: 'Arquivo' },
  files:    { Icon: FolderOpen, label: 'Arquivos',  inputLabel: 'Arquivo' },
  search:   { Icon: Search,     label: 'Pesquisa',  inputLabel: 'Consulta' },
  browser:  { Icon: Globe,      label: 'Navegador', inputLabel: 'Endereço' },
  image:    { Icon: ImageIcon,  label: 'Imagem',    inputLabel: 'Descrição' },
  agent:    { Icon: Users,      label: 'Sub-agente', inputLabel: 'Subtarefa delegada' },
  other:    { Icon: Cpu,        label: 'Ações',     inputLabel: 'Entrada' }
};

export const metaOf = name => TOOL_META[name] || { cat: 'other', running: `Executando ${name}`, done: name };

export function describe(step) {
  const meta = metaOf(step.name);
  const cat = CAT_META[meta.cat] || CAT_META.other;
  const label = step.status === 'running' ? meta.running : meta.done;
  return { cat: meta.cat, catMeta: cat, label, detail: (step.preview || '').trim(), subagent: step.subagent || null };
}

const fmtDuration = ms => {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}min ${s}s` : `${m}min`;
};

export const tryParse = raw => { try { return JSON.parse(raw); } catch { return null; } };

const fileUrl = (conversationId, filePath) => {
  const id = encodeURIComponent(String(conversationId || ''));
  const p = String(filePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${API}/api/conversations/${id}/download/${p}`;
};

// Contagens usadas no cartão compacto e no resumo final.
function summarize(steps, now) {
  const count = name => steps.filter(s => s.name === name).length;
  const files = count('write_file') + count('zip_outputs') + count('generate_image');
  const commands = count('bash') + count('run_python');
  const searches = count('web_search') + count('web_fetch');
  const reads = count('read_file') + count('list_files');
  const delegations = count(SUBAGENT_TOOL);
  const errors = steps.filter(s => s.status === 'error').length;
  const starts = steps.map(s => s.started).filter(Boolean);
  const ends = steps.map(s => s.ended).filter(Boolean);
  const first = starts.length ? Math.min(...starts) : now;
  const last = steps.some(s => s.status === 'running') || !ends.length ? now : Math.max(...ends);
  return { total: steps.length, files, commands, searches, reads, delegations, errors, elapsed: fmtDuration(last - first) };
}

// Frase-resumo montada a partir das categorias presentes (sem inventar nada).
function summaryPhrase(s) {
  const parts = [];
  if (s.delegations) parts.push(s.delegations === 1 ? 'delegando para um sub-agente' : `delegando para ${s.delegations} sub-agentes`);
  if (s.searches) parts.push('pesquisando na internet');
  if (s.reads) parts.push('analisando arquivos');
  if (s.commands) parts.push('executando comandos');
  if (s.files) parts.push('gerando arquivos');
  if (!parts.length) return 'Preparando o trabalho';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function statusIcon(status) {
  if (status === 'running') return <Loader size={15} className="esSpin" />;
  if (status === 'error') return <AlertCircle size={15} className="esErr" />;
  return <CheckCircle2 size={15} className="esOk" />;
}

// ─── Painel de detalhe: formata o resultado conforme a categoria da etapa ────
function ResultView({ step, conversationId }) {
  if (step.status === 'running') return <div className="esWaiting"><Loader size={14} className="esSpin" /> Executando…</div>;

  const parsed = tryParse(step.result);
  const cat = metaOf(step.name).cat;

  // Delegação a sub-agente: o que volta ao agente principal é só isto — o
  // resultado resumido e os arquivos gerados. Vem ANTES do tratamento genérico
  // de erro porque uma subtarefa incompleta traz as duas coisas (o motivo da
  // falha E o que deu tempo de apurar), e esconder o parcial não ajuda ninguém.
  if (step.name === SUBAGENT_TOOL && (parsed?.resultado != null || parsed?.arquivos)) {
    return <div className="esDelegation">
      {parsed.especialista && <div className="esDelegWho"><Users size={13} /> {parsed.especialista}</div>}
      {parsed.error && <pre className="esOutput err">{parsed.error}</pre>}
      <pre className="esOutput">{parsed.resultado || '(o sub-agente não devolveu texto)'}</pre>
      {Array.isArray(parsed.arquivos) && parsed.arquivos.length > 0 && <>
        <span className="esBlockLabel">Arquivos gerados pelo sub-agente</span>
        <ul className="esFileList">{parsed.arquivos.map(f => <li key={f}>{f}</li>)}</ul>
      </>}
    </div>;
  }

  if (parsed?.error) return <pre className="esOutput err">{parsed.error}</pre>;

  // Imagens geradas: miniatura clicável do que foi produzido.
  if (step.name === 'generate_image' && Array.isArray(parsed?.saved) && parsed.saved.length) {
    return <div className="esThumbs">
      {parsed.saved.map(p => (
        <a key={p} className="esThumb" href={fileUrl(conversationId, p)} target="_blank" rel="noreferrer" title={`${p} — abrir`}>
          <img src={fileUrl(conversationId, p)} alt={p} loading="lazy" />
          <span>{p.split('/').pop()}</span>
        </a>
      ))}
    </div>;
  }

  // Pesquisa na internet: lista de resultados (título, resumo, link).
  if (cat === 'search' && Array.isArray(parsed?.results) && parsed.results.length) {
    return <ul className="esResults">
      {parsed.results.map((r, i) => (
        <li key={i}>
          <a href={r.url} target="_blank" rel="noreferrer">{r.title || r.url} <ExternalLink size={11} /></a>
          {r.snippet && <p>{r.snippet}</p>}
          {r.url && <small>{r.url}</small>}
        </li>
      ))}
    </ul>;
  }

  // Página aberta no navegador: miniatura (se houver) + endereço + prévia do texto.
  if (cat === 'browser' && (parsed?.content || step.thumb)) {
    const pageUrl = parsed?.url || step.preview;
    return <div className="esPage">
      {step.thumb && (
        <a className="esShot" href={fileUrl(conversationId, step.thumb)} target="_blank" rel="noreferrer" title="Abrir a miniatura em tamanho real">
          <img src={fileUrl(conversationId, step.thumb)} alt="Miniatura da página" loading="lazy" />
        </a>
      )}
      {pageUrl && <a className="esPageUrl" href={pageUrl} target="_blank" rel="noreferrer">{pageUrl} <ExternalLink size={11} /></a>}
      {parsed?.content && <pre className="esOutput">{String(parsed.content).slice(0, 4000)}</pre>}
    </div>;
  }

  // Terminal / Python: mostra a saída como um console.
  if (cat === 'terminal' && parsed && ('output' in parsed || 'exitCode' in parsed)) {
    const failed = typeof parsed.exitCode === 'number' && parsed.exitCode !== 0;
    return <pre className={`esOutput ${failed ? 'err' : ''}`}>{parsed.output || '(sem saída)'}</pre>;
  }

  // Leitura de arquivo: mostra o conteúdo do arquivo.
  if (step.name === 'read_file' && parsed?.content != null) return <pre className="esOutput">{parsed.content || '(arquivo vazio)'}</pre>;

  // Lista de arquivos.
  if (step.name === 'list_files' && Array.isArray(parsed?.files)) {
    return parsed.files.length
      ? <ul className="esFileList">{parsed.files.map(f => <li key={f}>{f}</li>)}</ul>
      : <div className="esEmpty">Nenhum arquivo encontrado.</div>;
  }

  // Gravação de arquivo: já mostramos o conteúdo escrito acima; aqui, confirmação.
  if (step.name === 'write_file' && parsed?.ok) {
    return <pre className="esOutput">Arquivo salvo: {parsed.path}{parsed.size != null ? ` · ${parsed.size} bytes` : ''}</pre>;
  }

  return <pre className="esOutput">{step.result ? (parsed ? JSON.stringify(parsed, null, 2) : step.result) : '(sem saída)'}</pre>;
}

// ─── Janela ao vivo (overlay em tela cheia) ─────────────────────────────────
function WorkspaceOverlay({ steps, live, sum, conversationId, onClose }) {
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(steps.length - 1);
  const [follow, setFollow] = useState(true);
  const listRef = useRef(null);

  const runningIdx = steps.findIndex(s => s.status === 'running');

  // Enquanto acompanha, seleciona a etapa em execução (ou a última). Depende de
  // valores primitivos — não da identidade do array, que muda a cada render e
  // faria o efeito disparar sem parar.
  useEffect(() => {
    if (!follow) return;
    setSelected(runningIdx > -1 ? runningIdx : steps.length - 1);
  }, [follow, runningIdx, steps.length]);

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

  // As etapas dos sub-agentes aparecem recuadas DENTRO da delegação que as
  // disparou (ver executionSteps.js). Com o filtro por categoria ligado, o
  // recuo perde o sentido — a lista já não é a sequência completa.
  const grouped = useMemo(() => groupExecutionSteps(steps), [steps]);
  const visible = filter === 'all'
    ? grouped
    : grouped.filter(({ s }) => metaOf(s.name).cat === filter).map(row => ({ ...row, depth: 0 }));

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
          {sum.delegations > 0 && <span><b>{sum.delegations}</b> {sum.delegations === 1 ? 'delegação' : 'delegações'}</span>}
          {sum.files > 0 && <span><b>{sum.files}</b> arquivos</span>}
          <span className={sum.errors ? 'esStatErr' : ''}><b>{sum.errors}</b> {sum.errors === 1 ? 'erro' : 'erros'}</span>
          <span className="esWinTime">{sum.elapsed}</span>
        </div>

        {cats.length > 2 && (
          <div className="esFilters" role="tablist" aria-label="Filtrar etapas por tipo">
            {cats.map(c => (
              <button key={c} role="tab" aria-selected={filter === c} className={filter === c ? 'on' : ''} onClick={() => setFilter(c)}>
                {c === 'all' ? 'Tudo' : CAT_META[c].label}
              </button>
            ))}
          </div>
        )}

        <div className="esWinBody">
          <ol className="esSteps" ref={listRef}>
            {visible.map(({ s, i, depth }) => {
              const info = describe(s);
              const CatIcon = info.catMeta.Icon;
              return (
                <li key={i} className={`esStepIn${depth ? ' esStepSub' : ''}`}>
                  <button className={`esStep ${s.status} ${selected === i ? 'sel' : ''}`} onClick={() => pick(i)}>
                    <span className="esStepStat">{statusIcon(s.status)}</span>
                    <span className="esStepCat"><CatIcon size={14} /></span>
                    <span className="esStepText">
                      <b>{info.label}</b>
                      {info.subagent && <span className="esStepWho">{info.subagent}</span>}
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
                {active.name === 'write_file' && active.detail && (
                  <div className="esBlock">
                    <span className="esBlockLabel">Conteúdo salvo</span>
                    <pre className="esOutput">{active.detail}</pre>
                  </div>
                )}
                <div className="esBlock">
                  <span className="esBlockLabel">Resultado</span>
                  <ResultView step={active} conversationId={conversationId} />
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
function ExecutionSessionInner({ steps, live, conversationId }) {
  const [open, setOpen] = useState(false);
  // Relógio próprio, só enquanto a sessão está viva: mantém o tempo correndo de
  // forma suave sem depender de re-renders do chat.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const sum = useMemo(() => summarize(steps, now), [steps, now]);
  const delegs = useMemo(() => delegationSummary(steps), [steps]);
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
    if (sum.delegations) chips.push(`${sum.delegations} ${sum.delegations === 1 ? 'delegação' : 'delegações'}`);
    chips.push(hasError ? `${sum.errors} ${sum.errors === 1 ? 'erro' : 'erros'}` : 'nenhum erro');
  } else {
    chips.push(`${sum.total} ${sum.total === 1 ? 'etapa' : 'etapas'}`);
    if (delegs.running) chips.push(`${delegs.running} ${delegs.running === 1 ? 'sub-agente' : 'sub-agentes'} em andamento`);
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
      {open && <WorkspaceOverlay steps={steps} live={live} sum={sum} conversationId={conversationId} onClose={() => setOpen(false)} />}
    </div>
  );
}

// O array `steps` é recriado (novo .filter()) a cada render do chat, então
// comparar por identidade não adiantaria. Comparamos pelo CONTEÚDO relevante:
// quantidade de etapas e, em cada uma, status/fim/resultado. Assim, enquanto a
// resposta em texto vai fluindo (deltas) ou o relógio bate, um cartão de sessão
// já pronto acima NÃO é re-renderizado — que é o que engasgava a tela.
function sameSteps(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].status !== b[i].status || a[i].ended !== b[i].ended || a[i].result !== b[i].result) return false;
  }
  return true;
}

export const ExecutionSession = React.memo(ExecutionSessionInner, (a, b) =>
  a.live === b.live && a.conversationId === b.conversationId && sameSteps(a.steps, b.steps));
