import React from 'react';
import { Brain } from 'lucide-react';

export function MemoryTrace({ memory, onOpenMemory }) {
  if (!memory?.enabled) return null;
  const stats = memory.stats || {};
  const memories = stats.memoriesUsed ?? memory.memories?.length ?? 0;
  const chunks = stats.chunksUsed ?? memory.chunks?.length ?? 0;
  const summaries = stats.summariesUsed ?? memory.summaries ?? 0;
  const used = stats.contextTokens || memory.usedTokens || 0;
  const budget = stats.contextBudget || memory.budget || 0;
  if (memory.retrievalSkipped === 'low_signal') return <div className="memoryTrace compact"><Brain size={13}/> Memória não foi consultada nesta saudação.</div>;
  const hasSignal = memories || chunks || summaries || memory.history?.clipped;
  if (!hasSignal) return <div className="memoryTrace compact"><Brain size={13}/> Memoria ativa: nada relevante foi adicionado nesta resposta.</div>;
  return <details className="memoryTrace">
    <summary><Brain size={13}/><span>Usei {memories} memoria(s), {chunks} conversa(s) antiga(s){summaries ? ` e ${summaries} resumo(s)` : ''}.</span></summary>
    <div className="memoryTraceBody">
      <div className="memoryTraceMeta">Contexto: {used.toLocaleString('pt-BR')} / {budget.toLocaleString('pt-BR')} tokens{memory.truncated ? ' (encurtado)' : ''}. Historico: {memory.history?.included || 0} mensagens.</div>
      {memory.memories?.length > 0 && <div className="memoryTraceList">
        <b>Memorias usadas</b>
        {memory.memories.slice(0, 8).map((m, i) => <span key={`${m.id || i}-${i}`}>{m.scopeLabel || 'Memoria'} · {m.type || 'nota'} · {m.preview}</span>)}
      </div>}
      {memory.chunks?.length > 0 && <div className="memoryTraceList">
        <b>Conversas antigas</b>
        {memory.chunks.slice(0, 5).map((c, i) => <span key={`${c.title || i}-${i}`}>{c.scopeLabel || 'Escopo'} · {c.title}{c.date ? ` · ${c.date}` : ''}</span>)}
      </div>}
      <button type="button" onClick={(e) => { e.preventDefault(); onOpenMemory?.(); }}>Abrir memoria</button>
    </div>
  </details>;
}
