import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Circle, Copy, Check,
  Loader, Maximize2, Minimize2, Square, Terminal
} from 'lucide-react';
import { ResultView, describe, statusIcon } from './ExecutionSession.jsx';
import { groupExecutionSteps } from '../executionSteps.js';
import { sessionSummaryLine, summarizeSession, terminalStatus } from '../executionSessions.js';
import { isNearBottom } from '../chatScroll.js';
import { useComposerHeight } from '../hooks/useComposerHeight.js';

// TERMINAL INFERIOR — o painel de execução sai do balão e vira uma faixa própria
// do layout do chat, entre as mensagens e o compositor.
//
// POR QUE: enquanto a IA trabalhava, o balão da resposta crescia com um cartão
// grande e vivo (o `.esCard`) que empurrava o texto para fora da tela e brigava
// com a rolagem. O trabalho é uma sessão de execução — ele pertence a um painel
// fixo, recolhível e redimensionável, como o terminal de um editor de código.
//
// DESENHO: filho normal do `.chat` (nunca `position: fixed` sobre o conteúdo),
// então ele NÃO cobre compositor, botão de enviar, botão "Ir para o final",
// mensagens, modais nem os painéis laterais — ele reserva a própria altura.
//
// REAPROVEITAMENTO: as etapas, os rótulos humanizados, o agrupamento das
// delegações e a formatação dos resultados vêm do que já existia
// (`ExecutionSession.jsx`, `executionSteps.js`, `executionSessions.js`). Nada de
// segunda transformação: o overlay em tela cheia continua disponível como
// visualização secundária, lendo as mesmas etapas.

const STATE_KEY = 'fred_execution_dock_v1_state';
const HEIGHT_KEY = 'fred_execution_dock_v1_height';

const DOCK_MIN_HEIGHT = 180;
const DOCK_DEFAULT_HEIGHT = 300;
const DOCK_COLLAPSED_HEIGHT = 48;

// Alturas máximas: no desktop, 70% da janela; no celular, 55% — mais que isso e o
// compositor perde espaço útil de digitação.
function dockMaxHeight(viewportHeight = 800, mobile = false) {
  return Math.round(viewportHeight * (mobile ? 0.55 : 0.7));
}

function clampDockHeight(height, viewportHeight = 800, mobile = false) {
  const max = Math.max(DOCK_MIN_HEIGHT, dockMaxHeight(viewportHeight, mobile));
  return Math.min(max, Math.max(DOCK_MIN_HEIGHT, Math.round(Number(height) || DOCK_DEFAULT_HEIGHT)));
}

const readState = () => {
  const saved = localStorage.getItem(STATE_KEY);
  return ['collapsed', 'expanded', 'maximized'].includes(saved) ? saved : 'collapsed';
};
const readHeight = () => {
  const saved = Number(localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(saved) && saved > 0 ? saved : DOCK_DEFAULT_HEIGHT;
};

// ─── Saída ao vivo / resultado da etapa, com rolagem própria ────────────────
function StepOutput({ step, conversationId }) {
  const ref = useRef(null);
  const followRef = useRef(true);
  const [novos, setNovos] = useState(false);
  const progresso = step?.status === 'running' ? (step.progress?.texto || '') : '';

  // Rolagem INDEPENDENTE do chat: acompanha enquanto estiver no fim, para quando
  // a pessoa sobe e avisa que há log novo. Sem animação suave — a saída chega em
  // pedaços, e animar cada pedaço é o que faz a posição oscilar.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (followRef.current) { el.scrollTop = el.scrollHeight; setNovos(false); }
    else setNovos(true);
  }, [progresso, step?.result]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = isNearBottom(el, 24);
    followRef.current = atBottom;
    if (atBottom) setNovos(false);
  };
  const voltarAoFim = () => {
    const el = ref.current;
    if (!el) return;
    followRef.current = true;
    el.scrollTop = el.scrollHeight;
    setNovos(false);
  };

  if (!step) return <div className="esEmpty">Nenhuma etapa selecionada.</div>;

  const info = describe(step);
  const parado = Math.round((step.progress?.parado || 0) / 1000);

  return (
    <div className="dockOutput">
      <div className="dockOutputHead">
        <info.catMeta.Icon size={14} aria-hidden="true" />
        <b>{info.label}</b>
        {step.status === 'running' && step.progress?.linhas ? <span className="dockOutputMeta">{step.progress.linhas} linhas</span> : null}
      </div>
      {info.detail && (
        <pre className="dockCommand" title={info.catMeta.inputLabel}>
          <span className="dockPrompt" aria-hidden="true">$</span> {info.detail}
        </pre>
      )}
      {parado >= 5 && (
        <div className="esStall">
          <AlertCircle size={13} /> Sem saída há {parado}s — o comando pode estar processando em silêncio ou travado.
        </div>
      )}
      <div className="dockLogWrap">
        <pre className="dockLog" ref={ref} onScroll={onScroll} tabIndex={0} aria-label="Saída da etapa">
          {step.status === 'running'
            ? (progresso || 'Aguardando a primeira saída…')
            : null}
        </pre>
        {step.status !== 'running' && (
          <div className="dockResult"><ResultView step={step} conversationId={conversationId} /></div>
        )}
        {novos && (
          <button type="button" className="dockNewLogs" onClick={voltarAoFim} aria-label="Novos logs — voltar ao final">
            <ChevronDown size={13} /> Novos logs
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Terminal ───────────────────────────────────────────────────────────────
function ExecutionTerminalDockInner({
  session,
  conversationId,
  awaitingUser = false,
  stopped = false,
  onStop = null,
  stopDisabled = false,
  onOpenWorkspace = null
}) {
  const [mode, setMode] = useState(readState);
  const [height, setHeight] = useState(readHeight);
  const [selected, setSelected] = useState(null);
  const [copiado, setCopiado] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const dockRef = useRef(null);
  const stepsRef = useRef(null);
  const dragRef = useRef(null);
  // Publica a altura do terminal em `--dock-h`. Quem flutua no canto inferior
  // (o personagem do copiloto, `position: fixed`) soma esta altura à do
  // compositor — sem isso ele pousa em cima do cabeçalho do terminal e
  // intercepta os cliques de recolher/expandir. Foi o teste de navegador que
  // pegou: o clique no botão "Expandir o terminal" batia no avatar.
  const dockMeasureRef = useComposerHeight('--dock-h');

  const steps = session?.steps || [];
  const live = Boolean(session?.live);

  // RELÓGIO DENTRO DO TERMINAL: o contador de tempo bate aqui, não no chat. Sem
  // isso, o App re-renderizava a conversa inteira (e reprocessava markdown) uma
  // vez por segundo só para mover um número.
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => { localStorage.setItem(STATE_KEY, mode); }, [mode]);
  useEffect(() => { localStorage.setItem(HEIGHT_KEY, String(height)); }, [height]);

  // Janela encolheu (rotação do celular, painel lateral abrindo, zoom): a altura
  // guardada é reaplicada dentro do teto novo. Sem isto, um terminal de 500 px
  // salvo no desktop comeria o compositor inteiro numa tela de 600 px de altura.
  useEffect(() => {
    const reajustar = () => setHeight(h => clampDockHeight(h, window.innerHeight, window.innerWidth <= 720));
    window.addEventListener('resize', reajustar);
    reajustar();
    return () => window.removeEventListener('resize', reajustar);
  }, []);

  // Ao trocar de sessão, a seleção volta para "acompanhar a etapa atual".
  useEffect(() => { setSelected(null); }, [session?.id]);

  const runningIndex = steps.findIndex(step => step.status === 'running');
  const currentIndex = selected != null && steps[selected]
    ? selected
    : (runningIndex > -1 ? runningIndex : steps.length - 1);
  const currentStep = steps[currentIndex] || null;

  const sum = useMemo(() => summarizeSession(steps, now), [steps, now]);
  const grouped = useMemo(() => groupExecutionSteps(steps), [steps]);
  const status = terminalStatus({ live, awaitingUser, stopped, errors: sum.errors });

  // A lista de etapas acompanha a execução quando o usuário não escolheu uma.
  useEffect(() => {
    if (mode === 'collapsed') return; // recolhido não mexe em scroll
    if (selected != null) return;
    const el = stepsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length, selected, mode]);

  // ---- Redimensionamento (Pointer Events: mouse, caneta e toque) ----
  const onPointerDown = useCallback((event) => {
    if (mode === 'collapsed') return;
    const el = dockRef.current;
    if (!el) return;
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: el.getBoundingClientRect().height };
    document.body.classList.add('dockResizing');
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  }, [mode]);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const mobile = window.innerWidth <= 720;
    // A alça está no TOPO: arrastar para cima aumenta a altura.
    const next = clampDockHeight(drag.startHeight + (drag.startY - event.clientY), window.innerHeight, mobile);
    setHeight(next);
    if (mode === 'maximized') setMode('expanded');
  }, [mode]);

  const endDrag = useCallback((event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.classList.remove('dockResizing');
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
  }, []);

  // Limpeza de segurança: se o componente sair no meio de um arraste, a classe
  // que desliga a seleção de texto não pode ficar presa no body.
  useEffect(() => () => document.body.classList.remove('dockResizing'), []);

  // Alternativa por TECLADO à alça (acessibilidade: arrastar não é obrigatório).
  const onHandleKeyDown = (event) => {
    const passo = event.shiftKey ? 48 : 16;
    const mobile = window.innerWidth <= 720;
    if (event.key === 'ArrowUp') { event.preventDefault(); setHeight(h => clampDockHeight(h + passo, window.innerHeight, mobile)); }
    if (event.key === 'ArrowDown') { event.preventDefault(); setHeight(h => clampDockHeight(h - passo, window.innerHeight, mobile)); }
    if (event.key === 'Home') { event.preventDefault(); setMode('maximized'); }
    if (event.key === 'End') { event.preventDefault(); setMode('collapsed'); }
  };

  async function copiarLogs() {
    const texto = steps.map(step => {
      const info = describe(step);
      const entrada = info.detail ? `$ ${info.detail}` : '';
      const saida = step.status === 'running' ? (step.progress?.texto || '') : (step.result || '');
      return [`## ${info.label}`, entrada, saida].filter(Boolean).join('\n');
    }).join('\n\n');
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {}
  }

  if (!session || !steps.length) return null;

  const mobile = typeof window !== 'undefined' && window.innerWidth <= 720;
  const alturaAtual = mode === 'collapsed'
    ? DOCK_COLLAPSED_HEIGHT
    : (mode === 'maximized' ? dockMaxHeight(typeof window !== 'undefined' ? window.innerHeight : 800, mobile) : clampDockHeight(height, typeof window !== 'undefined' ? window.innerHeight : 800, mobile));

  const currentInfo = currentStep ? describe(currentStep) : null;
  const comandoAtual = currentInfo?.detail ? currentInfo.detail.split('\n')[0].slice(0, 90) : '';

  return (
    <section
      className={`execDock ${mode} ${status.tone}`}
      style={{ height: `${alturaAtual}px` }}
      ref={(el) => { dockRef.current = el; dockMeasureRef(el); }}
      aria-label="Terminal de execução"
    >
      {mode !== 'collapsed' && (
        <div
          className="dockHandle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionar o terminal (setas para cima e para baixo)"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onHandleKeyDown}
        />
      )}

      <header className="dockHead">
        <button
          type="button"
          className="dockTitle"
          onClick={() => setMode(m => (m === 'collapsed' ? 'expanded' : 'collapsed'))}
          aria-expanded={mode !== 'collapsed'}
          title={mode === 'collapsed' ? 'Expandir o terminal' : 'Recolher o terminal'}
        >
          <span className="dockIcon" aria-hidden="true">
            {live ? <Loader size={15} className="esSpin" /> : (status.tone === 'ok' ? <CheckCircle2 size={15} className="esOk" /> : <Terminal size={15} />)}
          </span>
          <span className="dockStatus">{status.label}</span>
          <span className="dockSummary">
            {live && currentInfo ? `${currentInfo.label}` : sessionSummaryLine(sum, { live, awaitingUser, stopped })}
          </span>
          {comandoAtual && <code className="dockCurrentCmd" title={currentInfo.detail}>{comandoAtual}</code>}
          <span className="dockClock">{sum.total} · {sum.elapsed}</span>
        </button>
        <div className="dockActions">
          <button type="button" onClick={copiarLogs} title="Copiar os logs desta execução" aria-label="Copiar os logs desta execução">
            {copiado ? <Check size={15} /> : <Copy size={15} />}
          </button>
          {onOpenWorkspace && (
            <button type="button" onClick={onOpenWorkspace} title="Abrir os detalhes em tela cheia" aria-label="Abrir os detalhes em tela cheia">
              <Maximize2 size={15} />
            </button>
          )}
          {live && onStop && (
            <button type="button" className="dockStop" onClick={onStop} disabled={stopDisabled}
              title="Interromper a execução" aria-label="Interromper a execução">
              <Square size={13} />
            </button>
          )}
          {mode === 'maximized'
            ? <button type="button" onClick={() => setMode('expanded')} title="Restaurar a altura" aria-label="Restaurar a altura"><Minimize2 size={15} /></button>
            : <button type="button" onClick={() => setMode('maximized')} title="Maximizar o terminal" aria-label="Maximizar o terminal"><ChevronUp size={15} /></button>}
          <button type="button" onClick={() => setMode(m => (m === 'collapsed' ? 'expanded' : 'collapsed'))}
            title={mode === 'collapsed' ? 'Expandir o terminal' : 'Recolher o terminal'}
            aria-label={mode === 'collapsed' ? 'Expandir o terminal' : 'Recolher o terminal'}>
            {mode === 'collapsed' ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </header>

      {mode !== 'collapsed' && (
        <div className="dockBody">
          <ol className="dockSteps" ref={stepsRef} aria-label="Etapas da execução">
            {grouped.map(({ s, i, depth }) => {
              const info = describe(s);
              const CatIcon = info.catMeta.Icon;
              return (
                <li key={`${s.id || i}`} className={depth ? 'dockStepSub' : ''}>
                  <button
                    type="button"
                    className={`dockStep ${s.status} ${i === currentIndex ? 'sel' : ''}`}
                    onClick={() => setSelected(i === selected ? null : i)}
                    aria-current={i === currentIndex ? 'step' : undefined}
                  >
                    <span className="dockStepStat">{statusIcon(s.status)}</span>
                    <span className="dockStepCat"><CatIcon size={13} /></span>
                    <span className="dockStepText">
                      <b>{info.label}</b>
                      {info.subagent && <span className="esStepWho">{info.subagent}</span>}
                      {info.detail && <small>{info.detail.split('\n')[0]}</small>}
                    </span>
                  </button>
                </li>
              );
            })}
            {live && <li className="dockNext"><Circle size={12} /> <span>Preparando próxima etapa…</span></li>}
          </ol>
          <StepOutput step={currentStep} conversationId={conversationId} />
        </div>
      )}
    </section>
  );
}

// A comparação é por CONTEÚDO das etapas: o array é recriado (novo `.filter()`)
// a cada render do chat, então comparar identidade não filtraria nada — e o
// terminal re-renderizaria a cada token da resposta em texto.
function sameSteps(a = [], b = []) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].status !== b[i].status || a[i].ended !== b[i].ended || a[i].result !== b[i].result || a[i].progress !== b[i].progress) return false;
  }
  return true;
}

export const ExecutionTerminalDock = React.memo(ExecutionTerminalDockInner, (a, b) =>
  a.session?.id === b.session?.id
  && a.session?.live === b.session?.live
  && a.conversationId === b.conversationId
  && a.awaitingUser === b.awaitingUser
  && a.stopped === b.stopped
  && a.stopDisabled === b.stopDisabled
  && sameSteps(a.session?.steps, b.session?.steps));
