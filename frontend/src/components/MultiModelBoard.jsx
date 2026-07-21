import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Copy, Check, Square, ArrowRightCircle, MessageSquareQuote, Layers, Coins, Clock3, AlertTriangle } from 'lucide-react';

// Quadro da execução MULTIMODELO: um cartão por modelo, com função, status ao
// vivo, resposta, tokens, custo e tempo — mais as ações por cartão (copiar,
// continuar com este modelo, pedir revisão) e o total da execução.

export const MULTI_MODE_LABEL = {
  compare: 'Comparação',
  council: 'Conselho de IAs',
  debate: 'Debate',
  pipeline: 'Especialistas em sequência'
};

const STATUS_LABEL = {
  aguardando: 'Aguardando',
  analisando: 'Analisando',
  respondendo: 'Respondendo',
  revisando: 'Revisando',
  concluido: 'Concluído',
  interrompido: 'Interrompido',
  erro: 'Erro'
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

export function MultiModelBoard({ multi, live = false, onCancelSlot, onContinueWith, onAskReview, onCombine }) {
  const [copiedSlot, setCopiedSlot] = useState(null);
  if (!multi?.models?.length) return null;

  async function copyCard(card) {
    try {
      await navigator.clipboard.writeText(card.text || '');
      setCopiedSlot(card.slot);
      setTimeout(() => setCopiedSlot(null), 1500);
    } catch {}
  }

  const totals = multi.totals || {};
  const totalCost = fmtCost(totals.costUsd ?? null);

  return <div className="mmBoard">
    <div className="mmBoardHead">
      <span className="mmBoardMode"><Layers size={14}/> {MULTI_MODE_LABEL[multi.mode] || 'Multimodelo'}{multi.rounds ? ` · ${multi.rounds} rodada(s)` : ''} · {multi.models.length} modelos</span>
      <span className="mmBoardTotals">
        {totals.tokens ? <span title="Tokens consumidos por todos os modelos"><Coins size={12}/> {totals.tokens.toLocaleString('pt-BR')} tokens</span> : null}
        {totalCost ? <span title="Custo total estimado da execução">{totalCost}</span> : null}
        {fmtTime(multi.elapsedMs) ? <span title="Tempo total"><Clock3 size={12}/> {fmtTime(multi.elapsedMs)}</span> : null}
      </span>
    </div>
    {multi.budgetExceeded && <div className="mmBudgetWarn"><AlertTriangle size={14}/> Orçamento máximo atingido — a execução foi encerrada antes de todas as etapas.</div>}
    <div className={`mmGrid mmGrid-${Math.min(multi.models.length, 3)}`}>
      {multi.models.map(card => {
        const running = live && RUNNING.has(card.status);
        return <div key={card.slot} className={`mmCard st-${card.status || 'concluido'}`}>
          <div className="mmCardHead">
            <div className="mmCardWho">
              <b title={card.id}>{card.name}</b>
              <small>{card.roleLabel}</small>
            </div>
            <span className={`mmStatus st-${card.status || 'concluido'}`}>
              {running && <span className="spin sm"/>}
              {STATUS_LABEL[card.status] || card.status || '—'}
            </span>
          </div>
          <div className="mmCardBody">
            {card.error && <div className="mmCardError">{card.error}</div>}
            {card.text
              ? <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{card.text}</ReactMarkdown>
              : (!card.error && <span className="muted small">{running ? 'Trabalhando...' : 'Sem resposta.'}</span>)}
            {card.truncated && <div className="mmCardNote">Resposta truncada pelo limite de tokens.</div>}
          </div>
          <div className="mmCardFoot">
            <span className="mmCardStats">
              {card.usage?.total_tokens ? `${card.usage.total_tokens.toLocaleString('pt-BR')} tokens` : ''}
              {fmtCost(card.costUsd) ? ` · ${fmtCost(card.costUsd)}` : ''}
              {fmtTime(card.elapsedMs) ? ` · ${fmtTime(card.elapsedMs)}` : ''}
            </span>
            <span className="mmCardActions">
              {running && onCancelSlot && <button onClick={() => onCancelSlot(card.slot)} title="Interromper somente este modelo"><Square size={12}/> Parar</button>}
              {!running && card.text && <>
                <button onClick={() => copyCard(card)} title="Copiar somente esta resposta">{copiedSlot === card.slot ? <Check size={12}/> : <Copy size={12}/>} Copiar</button>
                {onContinueWith && <button onClick={() => onContinueWith(card)} title="Seguir a conversa apenas com este modelo"><ArrowRightCircle size={12}/> Continuar com este</button>}
                {onAskReview && <button onClick={() => onAskReview(card)} title="Pedir que outro modelo revise esta resposta"><MessageSquareQuote size={12}/> Pedir revisão</button>}
              </>}
            </span>
          </div>
        </div>;
      })}
    </div>
    {!live && multi.mode === 'compare' && onCombine && <div className="mmBoardFoot">
      <button className="mmCombineBtn" onClick={onCombine}><Layers size={13}/> Gerar resposta combinada das melhores partes</button>
    </div>}
  </div>;
}
