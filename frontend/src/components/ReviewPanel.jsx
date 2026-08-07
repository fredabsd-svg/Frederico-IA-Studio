import React from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

// Painel de confiança da entrega (Fases 28 e 44).
//
// Mostra os achados da REVISÃO AUTOMÁTICA que o backend fez sobre o diff real
// (agent/reviewGate.js): segredo, código de depuração, teste desligado,
// remoção sensível, código sem teste, trabalho fora do plano. A interface só
// EXIBE — quem mede é o backend, sobre o git, não sobre opinião do modelo.
//
// "Sem bloqueios" não significa "sem achados": um TODO ou um console.log
// aparecem, mas não desqualificam a entrega. O que trava a leitura tranquila é
// blocker/high — e é isso que o cabeçalho comunica.

const SEVERITY_META = {
  blocker: { Icon: AlertOctagon,  label: 'bloqueio', cls: 'rv-blocker' },
  high:    { Icon: AlertTriangle, label: 'atenção',  cls: 'rv-high' },
  medium:  { Icon: Info,          label: 'revisar',  cls: 'rv-medium' },
  low:     { Icon: Info,          label: 'nota',     cls: 'rv-low' }
};

export const ReviewPanel = React.memo(function ReviewPanel({ review }) {
  if (!review || typeof review.total !== 'number') return null;
  const { counts = {}, findings = [], clean, total } = review;
  if (!total) {
    return (
      <div className="reviewPanel rv-ok">
        <div className="reviewHead">
          <CheckCircle2 size={15}/>
          <b>Revisão automática: nada a apontar</b>
        </div>
        <small>O diff foi conferido contra segredo, código de depuração, teste desligado, remoção sensível e escopo do plano.</small>
      </div>
    );
  }
  const resumo = ['blocker', 'high', 'medium', 'low']
    .filter(sev => counts[sev])
    .map(sev => `${counts[sev]} ${SEVERITY_META[sev].label}${counts[sev] > 1 ? 's' : ''}`)
    .join(' · ');
  return (
    <div className={`reviewPanel ${clean ? 'rv-ok' : 'rv-warn'}`}>
      <div className="reviewHead">
        {clean ? <CheckCircle2 size={15}/> : <AlertTriangle size={15}/>}
        <b>{clean ? 'Revisão automática: sem bloqueios' : 'Revisão automática: confira antes de publicar'}</b>
        <span className="reviewCounts">{resumo}</span>
      </div>
      <ul className="reviewList">
        {findings.map((item, index) => {
          const meta = SEVERITY_META[item.severity] || SEVERITY_META.low;
          const { Icon } = meta;
          return (
            <li key={`${item.kind}-${item.file || ''}-${item.line || index}`} className={meta.cls}>
              <span className="reviewIcon" aria-hidden="true"><Icon size={13}/></span>
              <span className="reviewText">
                {item.file && <code>{item.file}{item.line ? `:${item.line}` : ''}</code>}
                <span>{item.message}</span>
              </span>
              <span className="srOnly">{meta.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});
