import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Terminal, FolderOpen, Globe, Search, Image as ImageIcon, FileCog,
  X, CheckCircle2, AlertCircle, Circle, Cpu, Loader, ExternalLink, Users
} from 'lucide-react';
import { API } from '../constants.js';
import { groupExecutionSteps, SUBAGENT_TOOL } from '../executionSteps.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ambiente de Trabalho da IA
//
// Em vez de despejar dezenas de cartões "bash 0s" no chat, todas as chamadas de
// ferramenta de uma resposta são agrupadas numa ÚNICA sessão de execução.
//
// A EXPERIÊNCIA PRINCIPAL passou a ser o terminal inferior
// (`ExecutionTerminalDock.jsx`): o cartão grande e vivo que morava no balão saiu
// de cena, porque ele crescia dentro da mensagem e empurrava o texto da resposta
// para fora da tela. Na conversa ficou a linha compacta (`ExecutionSessionLine`).
//
// O que este arquivo ainda entrega, e os dois lugares reaproveitam:
//   * o vocabulário das etapas — TOOL_META, CAT_META, describe, statusIcon;
//   * a formatação do resultado por categoria — ResultView;
//   * a janela em TELA CHEIA (ExecutionWorkspace), visualização secundária com
//     filtro por categoria, lista completa e detalhe lado a lado.
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

// ARMADILHA: aqui havia `export { SUBAGENT_TOOL } from '../executionSteps.js'`.
// Um re-export cria a entrada de exportação do módulo, mas NÃO cria a variável
// local — então todo uso de SUBAGENT_TOOL dentro deste arquivo (em `summarize` e
// em `ResultView`) estourava `ReferenceError` e derrubava o app inteiro. O nome
// agora é IMPORTADO acima (virando um binding de verdade) e reexportado a partir
// dele, mantendo a mesma superfície pública do módulo.
export { SUBAGENT_TOOL };

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

export function statusIcon(status) {
  if (status === 'running') return <Loader size={15} className="esSpin" />;
  if (status === 'error') return <AlertCircle size={15} className="esErr" />;
  return <CheckCircle2 size={15} className="esOk" />;
}

// ─── Painel de detalhe: formata o resultado conforme a categoria da etapa ────
// Exportado: o terminal inferior (ExecutionTerminalDock) mostra o resultado da
// etapa selecionada com a MESMA formatação por categoria. Duplicar isto num
// segundo componente faria os dois painéis divergirem na primeira mudança.
export function ResultView({ step, conversationId }) {
  if (step.status === 'running') return <div className="esWaiting"><Loader size={14} className="esSpin" /> Executando…</div>;

  const parsed = tryParse(step.result);
  const cat = metaOf(step.name).cat;

  // Delegação a sub-agente: o que volta ao agente principal é só isto — o
  // resultado resumido e os arquivos gerados. Vem ANTES do tratamento genérico
  // de erro porque uma subtarefa incompleta traz as duas coisas (o motivo da
  // falha E o que deu tempo de apurar), e esconder o parcial não ajuda ninguém.
  if (step.name === SUBAGENT_TOOL && (parsed?.resultado != null || parsed?.arquivos)) {
    return <div className="esDelegation">
      {/* Quem REALMENTE executou. Antes, um especialista inexistente caía no
          assistente padrão em silêncio e este rótulo mostrava o nome pedido —
          o modelo entra junto para a substituição nunca passar despercebida. */}
      {(parsed.especialista || parsed.modelo) && <div className="esDelegWho">
        <Users size={13} /> {parsed.especialista || 'sub-agente'}
        {parsed.modelo && <span className="esDelegModel"> · {parsed.modelo}</span>}
      </div>}
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
                {active.status === 'running' && active.progress
                  ? <LiveOutput progress={active.progress} />
                  : (
                    <div className="esBlock">
                      <span className="esBlockLabel">Resultado</span>
                      <ResultView step={active} conversationId={conversationId} />
                    </div>
                  )}
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

// ─── Saída ao vivo do comando ───────────────────────────────────────────────
// Enquanto a etapa roda, a saída do sandbox chega em pedaços (evento
// tool_progress). Antes disso, um comando de 40 segundos era uma barra parada:
// não dava para saber se estava processando ou travado.
function LiveOutput({ progress }) {
  const ref = useRef(null);
  // Rola sozinho para o fim, como um terminal — a não ser que a pessoa tenha
  // subido para ler algo, aí respeita a posição dela.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const noFim = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (noFim) el.scrollTop = el.scrollHeight;
  }, [progress.texto]);

  const segundos = Math.round((progress.decorrido || 0) / 1000);
  const parado = Math.round((progress.parado || 0) / 1000);
  return (
    <div className="esBlock">
      <span className="esBlockLabel">
        Saída ao vivo
        <small className="esLiveMeta">
          {progress.linhas ? ` · ${progress.linhas} ${progress.linhas === 1 ? 'linha' : 'linhas'}` : ''}
          {segundos ? ` · ${segundos}s` : ''}
        </small>
      </span>
      {parado >= 5 && (
        <div className="esStall">
          <AlertCircle size={13} /> Sem saída há {parado}s — o comando pode estar processando em silêncio ou travado.
        </div>
      )}
      <pre className="esOutput esLive" ref={ref}>{progress.texto || 'Aguardando a primeira saída…'}</pre>
    </div>
  );
}

// ─── Overlay em tela cheia, aberto de fora ──────────────────────────────────
// Com o terminal inferior como experiência PRINCIPAL, a janela em tela cheia
// passa a ser a visualização secundária (filtros por categoria, lista completa,
// detalhe lado a lado). Ela continua lendo as MESMAS etapas — este wrapper só
// permite abri-la a partir do terminal, sem passar pelo cartão do balão.
export function ExecutionWorkspace({ steps = [], live = false, conversationId, onClose }) {
  const sum = useMemo(() => summarize(steps, Date.now()), [steps]);
  if (!steps.length) return null;
  return <WorkspaceOverlay steps={steps} live={live} sum={sum} conversationId={conversationId} onClose={onClose} />;
}
