import React from 'react';
import { Check, Circle, CircleDot, SkipForward, X } from 'lucide-react';

// Checklist do PLANO ESTRUTURADO da tarefa (ferramenta update_plan do backend).
//
// O plano chega pelo evento SSE `plan_update` ao vivo e pelo `execution_meta`
// da mensagem depois de um reload — a interface só EXIBE: quem decide status é
// o backend (um passo só vira "completed" com evidência, validada lá).
// Memoizado por referência do plano: só re-renderiza quando o plano muda, não
// a cada token do stream.

const STATUS_META = {
  pending:   { Icon: Circle,      label: 'pendente' },
  running:   { Icon: CircleDot,   label: 'em execução' },
  completed: { Icon: Check,       label: 'concluído' },
  failed:    { Icon: X,           label: 'falhou' },
  skipped:   { Icon: SkipForward, label: 'pulado' }
};

export const PlanChecklist = React.memo(function PlanChecklist({ plan }) {
  const steps = plan?.steps;
  if (!Array.isArray(steps) || !steps.length) return null;
  const done = steps.filter(step => step.status === 'completed').length;
  return (
    <div className="planChecklist" role="list" aria-label={`Plano da tarefa: ${done} de ${steps.length} passos concluídos`}>
      <div className="planHead">
        <span>Plano</span>
        <small>{done}/{steps.length}</small>
      </div>
      {steps.map(step => {
        const meta = STATUS_META[step.status] || STATUS_META.pending;
        const { Icon } = meta;
        return (
          <div key={step.id} role="listitem" className={`planStep planStep-${step.status}`}>
            <span className="planIcon" aria-hidden="true"><Icon size={13}/></span>
            <span className="planTitle">
              {step.title}
              {/* Evidência do passo concluído: o "porquê dá para confiar". */}
              {step.evidence && <small className="planEvidence" title={step.evidence}> — {step.evidence}</small>}
            </span>
            <span className="srOnly">{meta.label}</span>
          </div>
        );
      })}
    </div>
  );
});
