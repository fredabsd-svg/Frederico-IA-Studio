import React from 'react';
import { Brain } from 'lucide-react';

// MemoryTrace 3.0
// Mostra ao usuario quais memorias e conversas antigas foram usadas no contexto.
// O botao agora reflete o tipo de contexto recuperado:
//   - so memorias: "Ver memorias utilizadas"
//   - so conversas: "Ver conversas utilizadas"
//   - ambos: "Ver contexto recuperado"
//   - nenhum: botao oculto
export function MemoryTrace({ memory, onOpenMemory }) {
  if (!memory?.enabled) return null;
  const stats = memory.stats || {};
  const memories = stats.memoriesUsed ?? memory.memories?.length ?? 0;
  const chunks = stats.chunksUsed ?? memory.chunks?.length ?? 0;
  const summaries = stats.summariesUsed ?? memory.summaries ?? 0;
  const used = stats.contextTokens || memory.usedTokens || 0;
  const budget = stats.contextBudget || memory.budget || 0;

  if (memory.retrievalSkipped === 'low_signal') {
    return <div className="memoryTrace compact"><Brain size={13}/> Memória não foi consultada nesta saudação.</div>;
  }

  const hasSignal = memories || chunks || summaries || memory.history?.clipped;
  if (!hasSignal) {
    return <div className="memoryTrace compact"><Brain size={13}/> Nenhuma memória ou conversa antiga relevante foi encontrada para este pedido.</div>;
  }

  // Determina o texto do botão conforme o tipo de contexto recuperado
  let buttonLabel;
  if (memories > 0 && chunks > 0) {
    buttonLabel = 'Ver contexto recuperado';
  } else if (memories > 0) {
    buttonLabel = 'Ver memórias utilizadas';
  } else {
    buttonLabel = 'Ver conversas utilizadas';
  }

  return <details className="memoryTrace">
    <summary><Brain size={13}/><span>Usei {memories} memória(s), {chunks} conversa(s) antiga(s){summaries ? ` e ${summaries} resumo(s)` : ''}.</span></summary>
    <div className="memoryTraceBody">
      <div className="memoryTraceMeta">Contexto: {used.toLocaleString('pt-BR')} / {budget.toLocaleString('pt-BR')} tokens{memory.truncated ? ' (encurtado)' : ''}. Histórico: {memory.history?.included || 0} mensagens.</div>
      {memory.memories?.length > 0 && <div className="memoryTraceList">
        <b>Memórias utilizadas</b>
        {memory.memories.slice(0, 8).map((m, i) => (
          <span key={`${m.id || i}-${i}`}>
            {m.scopeLabel || 'Memória'} · {m.type || 'nota'} · {m.preview}
            {m.reason && <em className="memoryTraceReason"> — {m.reason}</em>}
          </span>
        ))}
      </div>}
      {memory.chunks?.length > 0 && <div className="memoryTraceList">
        <b>Conversas antigas utilizadas</b>
        {memory.chunks.slice(0, 5).map((c, i) => (
          <span key={`${c.title || i}-${i}`}>
            {c.scopeLabel || 'Escopo'} · {c.title}{c.date ? ` · ${c.date}` : ''}
            {c.reason && <em className="memoryTraceReason"> — {c.reason}</em>}
          </span>
        ))}
      </div>}
      <button type="button" onClick={(e) => { e.preventDefault(); onOpenMemory?.(); }}>{buttonLabel}</button>
    </div>
  </details>;
}
