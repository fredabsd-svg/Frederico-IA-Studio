import React, { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader } from 'lucide-react';
import { sessionSummaryLine, summarizeSession, terminalStatus } from '../executionSessions.js';

// Linha compacta da execução DENTRO da mensagem.
//
// Substitui o cartão grande e vivo (`.esCard`) que crescia no balão enquanto a
// IA trabalhava — empurrando o texto da resposta para fora da tela e brigando
// com a rolagem. O trabalho em andamento agora aparece no terminal inferior;
// aqui fica o registro, com o atalho para recarregar a sessão no terminal.
//
// Mora num módulo próprio (e não junto do terminal) porque ela é renderizada em
// TODA mensagem com ferramentas: mantendo-a leve, o terminal e a janela em tela
// cheia podem ficar em chunks separados, baixados só quando aparecem.
export function ExecutionSessionLine({ session, awaitingUser = false, onOpenInDock }) {
  const steps = session?.steps || [];
  // Relógio congelado no primeiro render: a linha do histórico não precisa
  // contar segundos — quem faz isso é o terminal, com relógio próprio.
  const [now] = useState(() => Date.now());
  const sum = useMemo(() => summarizeSession(steps, now), [steps, now]);
  if (!steps.length) return null;
  const status = terminalStatus({ live: session.live, awaitingUser, errors: sum.errors });
  const Icon = session.live ? Loader : (sum.errors ? AlertCircle : CheckCircle2);
  return (
    <div className={`execLine ${status.tone}`}>
      <span className="execLineIcon" aria-hidden="true">
        <Icon size={15} className={session.live ? 'esSpin' : (sum.errors ? 'esErr' : 'esOk')} />
      </span>
      <span className="execLineText">{sessionSummaryLine(sum, { live: session.live, awaitingUser })}</span>
      <button type="button" className="execLineBtn" onClick={() => onOpenInDock?.(session.id)}>
        {session.live ? 'Ver no terminal' : 'Ver detalhes'}
      </button>
    </div>
  );
}
