import React, { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { API } from './constants.js';
import { actionForCompanionEvent } from './companionEventActions.js';

const PAUSA_MS = 3000;
const MIN_CHARS = { baixa: 140, media: 80, alta: 40 };
const SNOOZE_MS = 20000;
const BUBBLE_PHRASES = [
  'Quer que eu dê uma olhada na escrita?',
  'Posso revisar esse texto rapidinho?',
  'Deixa eu ajustar ortografia e clareza?',
  'Quer uma revisão antes de enviar?',
  'Posso deixar isso mais claro pra você?',
];

export function WritingBubble({ settings, draft, onApply, name, onPhase }) {
  const [phase, setPhase] = useState('idle');
  const [phrase, setPhrase] = useState(BUBBLE_PHRASES[0]);
  const [revised, setRevised] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const handledRef = useRef('');
  const snoozeUntil = useRef(0);
  const lastPhrase = useRef(-1);
  const timer = useRef(null);
  const rootRef = useRef(null);

  const enabled = settings.enabled && settings.proactiveWriting && ['auxiliar', 'proativo'].includes(settings.mode);
  const minChars = MIN_CHARS[settings.writingSensitivity] || MIN_CHARS.media;
  const text = (draft || '').trim();

  useEffect(() => { onPhase?.(phase); }, [phase]); // eslint-disable-line

  useEffect(() => {
    clearTimeout(timer.current);
    if (!enabled) { setPhase('idle'); return; }
    if ((phase === 'result' || phase === 'error' || phase === 'loading') && handledRef.current === text) return;
    if (text.length < minChars || text === handledRef.current || Date.now() < snoozeUntil.current) {
      if (phase === 'ask') setPhase('idle');
      return;
    }
    timer.current = setTimeout(() => {
      const idx = (lastPhrase.current + 1 + Math.floor((text.length % BUBBLE_PHRASES.length))) % BUBBLE_PHRASES.length;
      const pick = idx === lastPhrase.current ? (idx + 1) % BUBBLE_PHRASES.length : idx;
      lastPhrase.current = pick;
      setPhrase(BUBBLE_PHRASES[pick]);
      setPhase('ask');
    }, PAUSA_MS);
    return () => clearTimeout(timer.current);
  }, [text, enabled, minChars, phase]);

  useEffect(() => {
    if (phase === 'idle') return;
    function onKey(e) { if (e.key === 'Escape') decline(); }
    function onDoc(e) { if (rootRef.current && !rootRef.current.contains(e.target)) decline(); }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc); };
  }); // eslint-disable-line

  function decline() {
    handledRef.current = text;
    snoozeUntil.current = Date.now() + SNOOZE_MS;
    setPhase('idle');
  }
  async function accept() {
    setPhase('loading');
    setErrMsg('');
    try {
      const r = await fetch(`${API}/api/copilot/revise`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErrMsg(d.error || 'Não consegui revisar agora.'); setPhase('error'); return; }
      setRevised(d.revised || '');
      setPhase('result');
    } catch {
      setErrMsg('Falha de conexão. Tente de novo.');
      setPhase('error');
    }
  }
  function applyResult() {
    handledRef.current = revised.trim();
    onApply?.(revised);
    setPhase('idle');
  }

  if (phase === 'idle') return null;
  const reduced = settings.animationLevel === 'nenhum';

  return (
    <div ref={rootRef} className={`cmpBubble ${reduced ? 'noanim' : ''} phase-${phase}`} role="dialog" aria-label={`${name} — revisão de escrita`}>
      <span className="cmpBubbleArrow" aria-hidden="true" />
      {phase === 'ask' && (
        <div className="cmpBubbleBody">
          <div className="cmpBubbleText">{phrase}</div>
          <div className="cmpBubbleBtns">
            <button className="cmpBubbleYes" onClick={accept}><Check size={13} /> Pode olhar</button>
            <button className="cmpBubbleNo" onClick={decline}>Agora não</button>
          </div>
        </div>
      )}
      {phase === 'loading' && (
        <div className="cmpBubbleBody">
          <div className="cmpBubbleText"><span className="cmpBubbleSpin" /> Revisando seu texto…</div>
        </div>
      )}
      {phase === 'result' && (
        <div className="cmpBubbleBody">
          <div className="cmpBubbleLabel">Toque para usar esta versão:</div>
          <button className="cmpBubbleCard" onClick={applyResult} title="Substituir o texto pelo revisado">
            {revised}
          </button>
          <button className="cmpBubbleDismiss" onClick={decline} aria-label="Descartar"><X size={12} /> Manter o meu</button>
        </div>
      )}
      {phase === 'error' && (
        <div className="cmpBubbleBody">
          <div className="cmpBubbleText cmpBubbleErr">{errMsg}</div>
          <div className="cmpBubbleBtns">
            <button className="cmpBubbleYes" onClick={accept}>Tentar de novo</button>
            <button className="cmpBubbleNo" onClick={decline}>Fechar</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProactiveEventBubble({ event, name, onAccept, onDismiss, onOpen }) {
  const [working, setWorking] = useState(false);
  const action = actionForCompanionEvent(event);

  async function accept() {
    if (!action || working) return;
    setWorking(true);
    const accepted = await onAccept?.(event, action);
    if (accepted === false) setWorking(false);
  }

  return (
    <div className="cmpBubble cmpEventBubble" role="dialog" aria-label={`${name} — sugestão proativa`}>
      <span className="cmpBubbleArrow" aria-hidden="true" />
      <div className="cmpBubbleBody">
        <div className="cmpEventTitle">{event.title || 'Posso ajudar no próximo passo'}</div>
        {event.detail && <div className="cmpEventDetail">{event.detail}</div>}
        <div className="cmpBubbleBtns">
          {action ? (
            <button className="cmpBubbleYes" onClick={accept} disabled={working}>
              {working ? <><span className="cmpBubbleSpin" /> {action.pendingLabel}</> : <><Check size={13} /> {action.label}</>}
            </button>
          ) : (
            <button className="cmpBubbleYes" onClick={onOpen}>Ver detalhes</button>
          )}
          <button className="cmpBubbleNo" onClick={() => onDismiss?.(event.id)} disabled={working}>Agora não</button>
        </div>
      </div>
    </div>
  );
}
