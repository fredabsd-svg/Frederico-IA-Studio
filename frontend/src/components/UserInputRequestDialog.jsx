import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { KIND_ICON } from './UserInputRequest.jsx';

// Modal de resposta a uma pergunta interativa da IA.
//
// Mora num módulo separado do cartão inline de propósito: o cartão aparece na
// conversa (e por isso viaja no bundle de entrada), enquanto o modal só existe
// quando há pergunta pendente — então ele fica num chunk carregado sob demanda,
// sem custar nada na primeira pintura.
//
// Acessibilidade: role="dialog", aria-modal, foco inicial no primeiro campo,
// foco devolvido a quem abriu, Tab contido, Enter envia, Escape FECHA SEM
// DESCARTAR (o cartão inline permanece) e a validação vai por aria-live.

export function UserInputRequest({ request, onSubmit, onClose, submitting = false }) {
  const titleId = useId();
  const [value, setValue] = useState(() => request?.defaultValue || '');
  const [choice, setChoice] = useState(() => request?.defaultValue || request?.options?.[0]?.value || '');
  const [erro, setErro] = useState('');
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);
  // Foco devolvido a quem abriu o modal (o botão "Responder" ou o cartão).
  const openerRef = useRef(null);
  // Trava de envio duplo: o clique e o Enter podem chegar juntos.
  const sentRef = useRef(false);

  useEffect(() => {
    openerRef.current = document.activeElement;
    const frame = requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      try { openerRef.current?.focus?.(); } catch {}
    };
  }, []);

  // Esc fecha SEM descartar (o cartão inline permanece). Tab fica contido no
  // diálogo — sem isso o foco escaparia para o chat atrás.
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll('button, textarea, input, [href], select, [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!request) return null;

  function send(answer) {
    if (sentRef.current || submitting) return;
    const text = String(answer || '').trim();
    if (!text) {
      setErro('Escreva a sua resposta para continuar.');
      return;
    }
    sentRef.current = true;
    setErro('');
    onSubmit(text);
  }

  const Icon = KIND_ICON[request.kind] || CircleHelp;

  return (
    <div className="inputReqOverlay" role="presentation" onMouseDown={onClose}>
      <div
        className="inputReqDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onMouseDown={e => e.stopPropagation()}
      >
        <header className="inputReqHead">
          <span className="inputReqHeadIcon" aria-hidden="true"><Icon size={17} /></span>
          <h3 id={titleId}>{request.question}</h3>
          <button type="button" className="inputReqClose" onClick={onClose}
            title="Fechar sem descartar a pergunta" aria-label="Fechar sem descartar a pergunta">
            <X size={17} />
          </button>
        </header>

        {request.kind === 'text' && (
          <div className="inputReqBody">
            <label className="inputReqField">
              <span className="inputReqLabel">Sua resposta</span>
              <textarea
                ref={firstFieldRef}
                value={value}
                rows={4}
                placeholder={request.placeholder || 'Escreva aqui…'}
                onChange={e => { setValue(e.target.value); if (erro) setErro(''); }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(value); } }}
              />
            </label>
            <p className="inputReqHint">Enter envia · Shift+Enter quebra linha</p>
          </div>
        )}

        {request.kind === 'select' && (
          <div className="inputReqBody">
            <div className="inputReqOptions" role="radiogroup" aria-labelledby={titleId}>
              {(request.options || []).map((option, i) => {
                const sel = choice === option.value;
                return (
                  <button
                    key={option.value}
                    ref={i === 0 ? firstFieldRef : null}
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    className={`inputReqOption ${sel ? 'sel' : ''}`}
                    onClick={() => { setChoice(option.value); if (erro) setErro(''); }}
                    onDoubleClick={() => send(option.label)}
                  >
                    <span className="inputReqOptionMark" aria-hidden="true">{sel ? <Check size={14} /> : null}</span>
                    <span className="inputReqOptionText">
                      <b>{option.label}</b>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* O estado é comunicado por texto e por `aria-live`, não só por cor. */}
        <div className="inputReqError" role="status" aria-live="polite">{erro}</div>

        <footer className="inputReqActions">
          {request.kind === 'confirm' ? (
            <>
              <button type="button" className="inputReqSecondary" onClick={() => send(request.cancelLabel || 'Não')}
                disabled={submitting}>
                {request.cancelLabel || 'Não'}
              </button>
              <button type="button" className="primary" ref={firstFieldRef} onClick={() => send(request.confirmLabel || 'Sim')}
                disabled={submitting}>
                <Check size={15} /> {request.confirmLabel || 'Sim'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="inputReqSecondary" onClick={onClose} disabled={submitting}>
                Responder depois
              </button>
              <button type="button" className="primary" disabled={submitting}
                onClick={() => send(request.kind === 'select'
                  ? (request.options || []).find(o => o.value === choice)?.label || ''
                  : value)}>
                <Check size={15} /> Enviar resposta
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
