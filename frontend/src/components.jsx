import React from 'react';

// Chip de ferramenta em execução/concluída dentro de uma mensagem
export function ToolStep({ step }) {
  const end = step.ended || Date.now();
  const secs = Math.max(0, Math.round((end - step.started) / 1000));
  return <div className={`toolstep ${step.status}`}>
    <span className="ic">{step.status === 'running' ? <span className="spin sm"/> : '✓'}</span>
    <code>{step.name}</code>
    <span className="sec">{secs}s</span>
    {step.status === 'running' && <span className="lbl">executando…</span>}
  </div>;
}

// Slider de personalidade do Assistant Studio
export function Slider({ label, hintA, hintB, value, onChange }) {
  return <div className="slider">
    <div className="sliderTop"><span>{label}</span><b>{value}</b></div>
    <input type="range" min="0" max="100" value={value} onChange={e => onChange(e.target.value)}/>
    <div className="sliderHints"><span>{hintA}</span><span>{hintB}</span></div>
  </div>;
}

// Casca padrão dos modais (overlay + cabeçalho com fechar)
export function Modal({ title, icon, onClose, children }) {
  return <div className="modalOverlay" onClick={onClose}>
    <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
      <div className="modalHead">
        <h2>{icon} {title}</h2>
        <button className="x" onClick={onClose} aria-label="Fechar">✕</button>
      </div>
      <div className="modalBody">{children}</div>
    </div>
  </div>;
}
