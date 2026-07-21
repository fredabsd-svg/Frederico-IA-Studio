import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Copy, Check, Square, ArrowRightCircle, MessageSquareQuote, Layers, Coins, Clock3, AlertTriangle, ChevronDown, ChevronRight, Maximize2, X, GitCompare, Users, Swords, Workflow, Gavel } from 'lucide-react';

// Quadro da execução MULTIMODELO. Cada MODO tem uma apresentação própria,
// coerente com a sua lógica de execução:
//   compare  — cartões iguais lado a lado (competição, sem síntese);
//   council  — pareceres recolhíveis + "Conclusão do Conselho" (coordenador);
//   debate   — organizado por rodadas (crítica/réplica) + conclusão;
//   pipeline — linha do tempo vertical numerada (cadeia); a última etapa é o
//              "Resultado final da sequência", sem síntese extra.

export const MULTI_MODE_LABEL = {
  compare: 'Comparação',
  council: 'Conselho de IAs',
  debate: 'Debate',
  pipeline: 'Especialistas em sequência'
};

const MODE_ICON = { compare: GitCompare, council: Users, debate: Swords, pipeline: Workflow };
const MODE_HINT = {
  compare: 'Modelos competindo — mesma pergunta, respostas independentes.',
  council: 'Modelos colaborando — um coordenador consolida a conclusão.',
  debate: 'Modelos debatendo — rodadas de crítica e revisão.',
  pipeline: 'Modelos em sequência — cada etapa recebe o trabalho da anterior.'
};

// Nomes das etapas do pipeline por posição (o usuário pediu que a sequência não
// use "resposta consolidada" — cada etapa ASSUME o trabalho anterior).
const PIPELINE_STEP_TITLE = ['Análise inicial', 'Revisão especializada', 'Aprofundamento', 'Validação final'];
function pipelineStepTitle(index, total) {
  if (index === total - 1) return 'Resultado final da sequência';
  return PIPELINE_STEP_TITLE[index] || `Etapa ${index + 1}`;
}

const STATUS_LABEL = {
  aguardando: 'Aguardando', analisando: 'Analisando', respondendo: 'Respondendo',
  revisando: 'Revisando', concluido: 'Concluído', interrompido: 'Interrompido', erro: 'Erro'
};
const RUNNING = new Set(['aguardando', 'analisando', 'respondendo', 'revisando']);

function fmtCost(v) {
  if (v === null || v === undefined) return null;
  if (v === 0) return 'grátis';
  return v < 0.01 ? `US$ ${v.toFixed(4)}` : `US$ ${v.toFixed(2)}`;
}
function fmtTime(ms) {
  if (!ms) return null;
  return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}
function Md({ children }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{children}</ReactMarkdown>;
}

// Corpo de resposta com recolhimento: respostas longas começam recolhidas para
// nenhuma etapa dominar a tela (requisito geral do redesenho).
function CardText({ text, running, error, truncated, collapsedByDefault }) {
  const long = (text || '').length > 900;
  const [open, setOpen] = useState(!collapsedByDefault);
  const collapsed = long && collapsedByDefault && !open;
  return <div className="mmCardBody">
    {error && <div className="mmCardError">{error}</div>}
    {text
      ? <div className={collapsed ? 'mmClip' : ''}><Md>{text}</Md></div>
      : (!error && <span className="muted small">{running ? 'Trabalhando...' : 'Sem resposta.'}</span>)}
    {long && collapsedByDefault && <button className="mmMore" onClick={() => setOpen(o => !o)}>
      {open ? <>Recolher <ChevronDown size={12}/></> : <>Mostrar tudo <ChevronRight size={12}/></>}
    </button>}
    {truncated && <div className="mmCardNote">Resposta truncada pelo limite de tokens.</div>}
  </div>;
}

function StatusBadge({ status, live }) {
  const running = live && RUNNING.has(status);
  return <span className={`mmStatus st-${status || 'concluido'}`}>
    {running && <span className="spin sm"/>}{STATUS_LABEL[status] || status || '—'}
  </span>;
}

function CardStats({ card }) {
  const bits = [
    card.usage?.total_tokens ? `${card.usage.total_tokens.toLocaleString('pt-BR')} tokens` : null,
    fmtCost(card.costUsd), fmtTime(card.elapsedMs)
  ].filter(Boolean);
  return bits.length ? <span className="mmCardStats">{bits.join(' · ')}</span> : <span className="mmCardStats"/>;
}

export function MultiModelBoard({ multi, live = false, onCancelSlot, onContinueWith, onAskReview, onCombine }) {
  const [copiedSlot, setCopiedSlot] = useState(null);
  const [full, setFull] = useState(null); // card em tela cheia
  if (!multi?.models?.length) return null;

  async function copyText(text, key) {
    try { await navigator.clipboard.writeText(text || ''); setCopiedSlot(key); setTimeout(() => setCopiedSlot(null), 1500); } catch {}
  }

  const mode = multi.mode || 'compare';
  const ModeIcon = MODE_ICON[mode] || Layers;
  const totals = multi.totals || {};
  const totalCost = fmtCost(totals.costUsd ?? null);

  // Ações padrão de um cartão (copiar, continuar, revisão, tela cheia).
  const cardActions = (card, { canContinue = true } = {}) => {
    const running = live && RUNNING.has(card.status);
    return <span className="mmCardActions">
      {running && onCancelSlot && <button onClick={() => onCancelSlot(card.slot)} title="Interromper somente este modelo"><Square size={12}/> Parar</button>}
      {!running && card.text && <>
        <button onClick={() => copyText(card.text, card.slot)} title="Copiar esta resposta">{copiedSlot === card.slot ? <Check size={12}/> : <Copy size={12}/>} Copiar</button>
        <button onClick={() => setFull(card)} title="Abrir em tela cheia"><Maximize2 size={12}/> Tela cheia</button>
        {canContinue && onContinueWith && <button onClick={() => onContinueWith(card)} title="Seguir a conversa apenas com este modelo"><ArrowRightCircle size={12}/> Continuar com este</button>}
        {onAskReview && <button onClick={() => onAskReview(card)} title="Pedir que outro modelo revise esta resposta"><MessageSquareQuote size={12}/> Pedir revisão</button>}
      </>}
    </span>;
  };

  // Cabeçalho de um cartão: nome, provedor, papel + status.
  const cardHead = (card, extra = null) => <div className="mmCardHead">
    <div className="mmCardWho">
      <b title={card.id}>{card.name}</b>
      <small>{[card.provider, card.roleLabel].filter(Boolean).join(' · ')}{extra ? ` · ${extra}` : ''}</small>
    </div>
    <StatusBadge status={card.status} live={live}/>
  </div>;

  return <div className={`mmBoard mmBoard-${mode}`}>
    <div className="mmBoardHead">
      <span className="mmBoardMode"><ModeIcon size={14}/> {MULTI_MODE_LABEL[mode] || 'Multimodelo'}
        {mode === 'debate' && multi.rounds ? ` · ${multi.rounds} rodada(s)` : ''} · {multi.models.length} modelos</span>
      <span className="mmBoardTotals">
        {totals.tokens ? <span title="Tokens de todos os modelos"><Coins size={12}/> {totals.tokens.toLocaleString('pt-BR')} tokens</span> : null}
        {totalCost ? <span title="Custo total estimado">{totalCost}</span> : null}
        {fmtTime(multi.elapsedMs) ? <span title="Tempo total"><Clock3 size={12}/> {fmtTime(multi.elapsedMs)}</span> : null}
      </span>
    </div>
    <div className="mmBoardHint">{MODE_HINT[mode]}</div>
    {multi.budgetExceeded && <div className="mmBudgetWarn"><AlertTriangle size={14}/> Orçamento máximo atingido — a execução foi encerrada antes de todas as etapas.</div>}

    {mode === 'compare' && <CompareView multi={multi} live={live} cardHead={cardHead} cardActions={cardActions}/>}
    {mode === 'council' && <CouncilView multi={multi} live={live} cardHead={cardHead} cardActions={cardActions} copyText={copyText} copiedSlot={copiedSlot} setFull={setFull}/>}
    {mode === 'debate' && <DebateView multi={multi} live={live} cardHead={cardHead} cardActions={cardActions}/>}
    {mode === 'pipeline' && <PipelineView multi={multi} live={live} cardActions={cardActions}/>}

    {!live && mode === 'compare' && onCombine && <div className="mmBoardFoot">
      <button className="mmCombineBtn" onClick={onCombine}><Layers size={13}/> Gerar resposta combinada das melhores partes</button>
    </div>}

    {full && <div className="mmFullOverlay" onClick={() => setFull(null)}>
      <div className="mmFullCard" onClick={e => e.stopPropagation()}>
        <div className="mmFullHead">
          <div className="mmCardWho"><b>{full.name}</b><small>{[full.provider, full.roleLabel].filter(Boolean).join(' · ')}</small></div>
          <div className="mmFullActions">
            <button onClick={() => copyText(full.text, `full-${full.slot}`)}>{copiedSlot === `full-${full.slot}` ? <Check size={14}/> : <Copy size={14}/>} Copiar</button>
            <button onClick={() => setFull(null)} title="Fechar"><X size={16}/></button>
          </div>
        </div>
        <div className="mmFullBody"><Md>{full.text || '_Sem resposta._'}</Md></div>
      </div>
    </div>}
  </div>;
}

// ── Comparação: cartões iguais lado a lado, sem síntese ──────────────────────
function CompareView({ multi, live, cardHead, cardActions }) {
  return <div className={`mmGrid mmGrid-${Math.min(multi.models.length, 3)}`}>
    {multi.models.map(card => <div key={card.slot} className={`mmCard st-${card.status || 'concluido'}`}>
      {cardHead(card)}
      <CardText text={card.text} running={live && RUNNING.has(card.status)} error={card.error} truncated={card.truncated} collapsedByDefault/>
      <div className="mmCardFoot"><CardStats card={card}/>{cardActions(card)}</div>
    </div>)}
  </div>;
}

// ── Conselho: pareceres recolhíveis + Conclusão do Conselho (coordenador) ────
function CouncilView({ multi, live, cardHead, cardActions, copyText, copiedSlot, setFull }) {
  return <>
    {multi.synthesis?.text && <div className="mmSynthesis">
      <div className="mmSynthesisHead"><Gavel size={15}/> <b>Conclusão do Conselho</b>
        <small>{[multi.synthesis.provider, multi.synthesis.name].filter(Boolean).join(' · ')}</small>
        <button className="mmSynthCopy" onClick={() => copyText(multi.synthesis.text, 'synth')} title="Copiar a conclusão">
          {copiedSlot === 'synth' ? <Check size={13}/> : <Copy size={13}/>}
        </button>
      </div>
      <div className="mmSynthesisBody"><Md>{multi.synthesis.text}</Md></div>
    </div>}
    <div className="mmCollapseList">
      <div className="mmCollapseTitle">Pareceres individuais ({multi.models.length})</div>
      {multi.models.map(card => <CollapsibleCard key={card.slot} card={card} live={live}
        cardHead={cardHead} cardActions={cardActions} defaultOpen={live || !multi.synthesis?.text}/>)}
    </div>
  </>;
}

function CollapsibleCard({ card, live, cardHead, cardActions, defaultOpen = false }) {
  const running = live && RUNNING.has(card.status);
  const [open, setOpen] = useState(defaultOpen || running);
  return <div className={`mmCard mmCollapse st-${card.status || 'concluido'} ${open ? 'open' : ''}`}>
    <button className="mmCollapseHead" onClick={() => setOpen(o => !o)}>
      {open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}
      <div className="mmCardWho"><b title={card.id}>{card.name}</b><small>{[card.provider, card.roleLabel].filter(Boolean).join(' · ')}</small></div>
      <StatusBadge status={card.status} live={live}/>
    </button>
    {open && <>
      <CardText text={card.text} running={running} error={card.error} truncated={card.truncated}/>
      <div className="mmCardFoot"><CardStats card={card}/>{cardActions(card)}</div>
    </>}
  </div>;
}

// ── Debate: organizado por rodadas (rodadas antigas recolhidas) + conclusão ──
function DebateView({ multi, live, cardHead, cardActions }) {
  // Reconstrói as rodadas a partir do history de cada modelo (meta final). Ao
  // vivo, o history ainda não existe: mostramos só a rodada corrente com o
  // texto que está chegando (as anteriores foram sobrescritas no streaming).
  const hasHistory = multi.models.some(m => m.history?.length);
  const liveRound = multi.round || 1;
  const maxHist = Math.max(1, ...multi.models.map(m => m.history?.length || 1));
  const totalRounds = hasHistory ? (multi.rounds || maxHist) : liveRound;

  const rounds = [];
  for (let r = 1; r <= totalRounds; r++) {
    const entries = multi.models.map(card => {
      const fromHistory = card.history?.find(h => h.round === r);
      const text = fromHistory ? fromHistory.text : (r === liveRound ? card.text : '');
      return { card, text };
    });
    rounds.push({ round: r, entries });
  }

  return <>
    <div className="mmRounds">
      {rounds.map(({ round, entries }) => {
        const isLast = round === totalRounds;
        return <DebateRound key={round} round={round} total={totalRounds} entries={entries}
          live={live} isLast={isLast} defaultOpen={isLast || (live && round === (multi.round || totalRounds))}
          cardHead={cardHead} cardActions={cardActions} hasHistory={hasHistory}/>;
      })}
    </div>
    {multi.synthesis?.text && <div className="mmSynthesis">
      <div className="mmSynthesisHead"><Gavel size={15}/> <b>Conclusão do debate</b>
        <small>{[multi.synthesis.provider, multi.synthesis.name].filter(Boolean).join(' · ')}</small>
      </div>
      <div className="mmSynthesisBody"><Md>{multi.synthesis.text}</Md></div>
    </div>}
  </>;
}

function DebateRound({ round, total, entries, live, isLast, defaultOpen, cardHead, cardActions }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className={`mmRound ${open ? 'open' : ''} ${isLast ? 'last' : ''}`}>
    <button className="mmRoundHead" onClick={() => setOpen(o => !o)}>
      {open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}
      <span className="mmRoundBadge">Rodada {round}<span className="muted"> / {total}</span></span>
      <span className="mmRoundKind">{round === 1 ? 'Respostas iniciais' : 'Críticas e revisões'}</span>
    </button>
    {open && <div className={`mmGrid mmGrid-${Math.min(entries.length, 3)}`}>
      {entries.map(({ card, text }) => <div key={card.slot} className={`mmCard st-${isLast ? (card.status || 'concluido') : 'concluido'}`}>
        {cardHead(card, `rodada ${round}`)}
        <CardText text={text} running={live && isLast && RUNNING.has(card.status)} error={isLast ? card.error : null} collapsedByDefault={!isLast}/>
        {isLast && <div className="mmCardFoot"><CardStats card={card}/>{cardActions(card)}</div>}
      </div>)}
    </div>}
  </div>;
}

// ── Pipeline: linha do tempo vertical numerada; última etapa em destaque ─────
function PipelineView({ multi, live, cardActions }) {
  const total = multi.models.length;
  return <ol className="mmTimeline">
    {multi.models.map((card, i) => {
      const isLast = i === total - 1;
      const stepTitle = pipelineStepTitle(i, total);
      const running = live && RUNNING.has(card.status);
      return <PipelineStep key={card.slot} card={card} index={i} total={total} isLast={isLast}
        stepTitle={stepTitle} running={running} cardActions={cardActions} live={live}/>;
    })}
  </ol>;
}

function PipelineStep({ card, index, total, isLast, stepTitle, running, cardActions, live }) {
  const [open, setOpen] = useState(isLast || running);
  return <li className={`mmStep st-${card.status || 'concluido'} ${isLast ? 'last' : ''} ${open ? 'open' : ''}`}>
    <div className="mmStepMarker"><span className="mmStepNum">{index + 1}</span></div>
    <div className="mmStepCard">
      <button className="mmStepHead" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}
        <div className="mmStepTitleWrap">
          <b className="mmStepTitle">{stepTitle}</b>
          <small>{[card.name, card.provider, card.roleLabel].filter(Boolean).join(' · ')}</small>
        </div>
        <StatusBadge status={card.status} live={live}/>
      </button>
      {index > 0 && open && <div className="mmStepFeed">Esta etapa recebeu a solicitação original e o resultado das {index} etapa(s) anterior(es).</div>}
      {open && <>
        <CardText text={card.text} running={running} error={card.error} truncated={card.truncated}/>
        <div className="mmCardFoot"><CardStats card={card}/>{cardActions(card, { canContinue: isLast })}</div>
      </>}
    </div>
  </li>;
}
