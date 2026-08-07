import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Moon, Check, X } from 'lucide-react';
import { API } from './constants.js';
import { useCopilotChat } from './hooks/useCopilotChat.js';
import { CopilotWorkspace } from './components/CopilotWorkspace.jsx';
import { NinoAvatar, NINO_CAPTION } from './components/NinoAvatar.jsx';
import {
  PROTECTED_CONTROL_SELECTORS,
  clampCompanionPosition,
  parseCompanionPosition,
  protectedBottomInset,
} from './companionPosition.js';
import { BOTTOM_BAND_EVENT } from './hooks/useComposerHeight.js';
import { actionForCompanionEvent } from './companionEventActions.js';

// Frederico Companion — a representação visual e interativa do Studio. É a
// CAMADA de experiência: a inteligência vem do núcleo do Studio. O avatar abre
// APENAS o painel do copiloto (abas Chat e Documentos); a configuração vive em
// Configurações. Além disso, ele observa o que você digita no chat principal e,
// discretamente, oferece revisar a escrita.
//
// Mudou nesta versão: o personagem passou a ser o Nino (components/NinoAvatar.jsx),
// com uma máquina de estados mais fina (analisando/digitando/sugestão/dúvida
// separados de "pensando"), reação a cutucar e, no celular, encolher e encostar
// na borda quando ocioso. Toda a mecânica anterior — arrastar com posição no
// localStorage, minimizar, níveis de animação, fila de eventos e balão de
// revisão — foi preservada.

const STATE_CAPTION = NINO_CAPTION;

// Parâmetros do balão proativo de revisão de escrita. Ajustáveis num só lugar.
// A sensibilidade escolhida pelo usuário controla quão cedo aparece.
const PAUSA_MS = 3000;                 // pausa na digitação antes de se oferecer
const MIN_CHARS = { baixa: 140, media: 80, alta: 40 };
const SNOOZE_MS = 20000;               // silêncio após "Agora não" (por rascunho)
const TUCK_MS = 8000;                  // ociosidade no celular antes de encostar
const BUBBLE_PHRASES = [
  'Quer que eu dê uma olhada na escrita?',
  'Posso revisar esse texto rapidinho?',
  'Deixa eu ajustar ortografia e clareza?',
  'Quer uma revisão antes de enviar?',
  'Posso deixar isso mais claro pra você?',
];

// Balão proativo de revisão de escrita. Observa o rascunho do chat principal e,
// após uma pausa, oferece revisar. Nunca altera nada sozinho — o usuário aceita.
// `onPhase` avisa o Companion para o personagem reagir junto (dúvida/analisando).
function WritingBubble({ settings, draft, onApply, name, onPhase }) {
  const [phase, setPhase] = useState('idle');   // idle | ask | loading | result | error
  const [phrase, setPhrase] = useState(BUBBLE_PHRASES[0]);
  const [revised, setRevised] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const handledRef = useRef('');                 // rascunho já tratado (não repetir)
  const snoozeUntil = useRef(0);
  const lastPhrase = useRef(-1);
  const timer = useRef(null);
  const rootRef = useRef(null);

  const enabled = settings.enabled && settings.proactiveWriting && ['auxiliar', 'proativo'].includes(settings.mode);
  const minChars = MIN_CHARS[settings.writingSensitivity] || MIN_CHARS.media;
  const text = (draft || '').trim();

  useEffect(() => { onPhase?.(phase); }, [phase]); // eslint-disable-line

  // Decide quando se oferecer: pausa + tamanho mínimo + rascunho ainda não tratado.
  useEffect(() => {
    clearTimeout(timer.current);
    if (!enabled) { setPhase('idle'); return; }
    // Enquanto exibindo um resultado/erro para ESTE rascunho, não reavaliar.
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

  // Esc / clique fora fecham (equivalente a "Agora não").
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
    handledRef.current = revised.trim();  // evita re-oferecer sobre o texto já aplicado
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

// Recuos da área útil do personagem. A leitura do DOM fica aqui, e não no módulo
// puro: `protectedBottomInset` decide quanto reservar, este trecho só mede.
function companionInsets(rightInset) {
  if (typeof window === 'undefined') return {};
  const rects = typeof document === 'undefined'
    ? []
    : PROTECTED_CONTROL_SELECTORS.flatMap(selector =>
      Array.from(document.querySelectorAll(selector), el => el.getBoundingClientRect()));
  return {
    right: window.innerWidth > 1180 ? rightInset : 8,
    bottom: protectedBottomInset(window.innerHeight, rects),
  };
}

// Alertas do Nino precisam aparecer no momento em que surgem, não apenas depois
// que o usuário abre o painel. Quando há uma ação conhecida, o botão executa a
// confirmação; avisos informativos continuam oferecendo acesso aos detalhes.
function ProactiveEventBubble({ event, name, onAccept, onDismiss, onOpen }) {
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

export function Companion({
  companion,
  busy, statusText, listening,
  model, allModels = [], assistants = [],
  draft = '', onApplyDraft,
  conversationId = null, conversationTitle = '',
  rightInset = 22,
  onEventAction,
  showToast,
}) {
  const { settings, persona, events } = companion;
  const copilot = useCopilotChat();
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(() => localStorage.getItem('fred_companion_min') === '1');
  const [pos, setPos] = useState(() => parseCompanionPosition(localStorage.getItem('fred_companion_pos')));
  const [successFlash, setSuccessFlash] = useState(false);
  const [bubblePhase, setBubblePhase] = useState('idle');
  const [tucked, setTucked] = useState(false);
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const prevBusy = useRef(busy);

  // A posição é persistida entre sessões, mas resolução, zoom e colunas do
  // workspace podem mudar. Revalida no início e a cada redimensionamento para o
  // Nino nunca ficar fora da tela ou escondido atrás do painel Atividade.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const keepVisible = () => {
      setPos(current => {
        if (!current) return current;
        const rect = rootRef.current?.getBoundingClientRect();
        const next = clampCompanionPosition(
          current,
          { width: window.innerWidth, height: window.innerHeight },
          { width: rect?.width, height: rect?.height },
          companionInsets(rightInset),
        );
        if (!next || (next.x === current.x && next.y === current.y)) return current;
        localStorage.setItem('fred_companion_pos', JSON.stringify(next));
        return next;
      });
    };
    const reset = () => {
      localStorage.removeItem('fred_companion_pos');
      localStorage.removeItem('fred_companion_min');
      setPos(null);
      setMinimized(false);
      setOpen(false);
    };
    keepVisible();
    window.addEventListener('resize', keepVisible);
    window.addEventListener(BOTTOM_BAND_EVENT, keepVisible);
    window.addEventListener('fred:companion-reset-position', reset);
    return () => {
      window.removeEventListener('resize', keepVisible);
      window.removeEventListener(BOTTOM_BAND_EVENT, keepVisible);
      window.removeEventListener('fred:companion-reset-position', reset);
    };
  }, [minimized, rightInset]);

  const unread = useMemo(() => events.filter(e => e.status === 'novo' || e.status === 'visto'), [events]);
  const hasCritical = unread.some(e => e.level === 'critico');
  const hasWarning = unread.some(e => e.level === 'aviso');
  const leadEvent = unread[0] || null;

  // Pequena reação positiva quando uma execução termina (busy: true -> false).
  useEffect(() => {
    if (prevBusy.current && !busy) {
      setSuccessFlash(true);
      const t = setTimeout(() => setSuccessFlash(false), 1800);
      return () => clearTimeout(t);
    }
    prevBusy.current = busy;
  }, [busy]);

  // Máquina de estados visual. A ordem reflete prioridade. As faixas de texto
  // vêm do statusText que o próprio chat já publica — nada de estado inventado.
  const state = useMemo(() => {
    if (settings.mode === 'apresentacao') return 'silencioso';
    if (busy) {
      const s = String(statusText || '').toLowerCase();
      if (/escrev|respond|gerando|redigindo|stream/.test(s)) return 'digitando';
      if (/analis|lend|conferind|verificand|planilha|arquivo|document|pesquis/.test(s)) return 'analisando';
      if (/execut|ferramenta|rodando|tool|comando|sandbox/.test(s)) return 'analisando';
      return 'pensando';
    }
    if (bubblePhase === 'loading') return 'analisando';
    if (bubblePhase === 'ask') return 'sugestao';
    if (listening) return 'observando';
    if (successFlash) return 'comemorando';
    if (hasCritical) return 'erro';
    if (hasWarning) return 'sugestao';
    if (unread.length) return 'duvida';
    return 'aguardando';
  }, [settings.mode, busy, statusText, listening, successFlash, hasCritical, hasWarning, unread.length, bubblePhase]);

  // Celular: depois de TUCK_MS sem interação, o personagem encolhe e se encosta
  // na borda direita. Qualquer toque/tecla devolve o tamanho normal.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (window.innerWidth > 560 || open || minimized) { setTucked(false); return undefined; }
    let timer = setTimeout(() => setTucked(true), TUCK_MS);
    const wake = () => {
      setTucked(false);
      clearTimeout(timer);
      timer = setTimeout(() => setTucked(true), TUCK_MS);
    };
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('keydown', wake);
    return () => { clearTimeout(timer); window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake); };
  }, [open, minimized, busy]);

  // Arrastar o personagem pela tela. Guarda a posição no localStorage.
  function onAvatarPointerDown(e) {
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    let moved = false;
    dragRef.current = { x: rect.left, y: rect.top };
    // Os recuos são medidos uma vez, no início do gesto: a faixa de controles não
    // muda de altura enquanto se arrasta, e medir a cada `pointermove` forçaria
    // layout dezenas de vezes por segundo.
    const insets = companionInsets(rightInset);
    const size = { width: rect.width, height: rect.height };
    function move(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      const next = clampCompanionPosition(
        { x: dragRef.current.x + dx, y: dragRef.current.y + dy },
        { width: window.innerWidth, height: window.innerHeight },
        size,
        insets,
      );
      if (next) setPos(next);
    }
    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (moved) {
        setPos(p => { if (p) localStorage.setItem('fred_companion_pos', JSON.stringify(p)); return p; });
      } else {
        setOpen(o => !o); // clique sem arrastar = abre/fecha o painel do copiloto
      }
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  if (!settings.enabled) return null;

  const characterName = settings.characterName || 'Nino';

  function toggleMin() {
    setMinimized(m => { const nv = !m; localStorage.setItem('fred_companion_min', nv ? '1' : '0'); if (nv) setOpen(false); return nv; });
  }

  async function acceptEvent(event, action) {
    const accepted = await onEventAction?.(event, action);
    if (accepted === false || accepted == null) return false;
    await companion.resolveEvent(event.id, `Ação confirmada: ${action.label}`);
    setOpen(false);
    return true;
  }

  const rootStyle = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : { '--companion-right': `${rightInset}px` };
  const quiet = settings.animationLevel !== 'completo';

  return (
    <>
      <div
        ref={rootRef}
        className={`companionRoot anim-${settings.animationLevel} ${minimized ? 'min' : ''} ${open ? 'open' : ''} ${tucked ? 'tucked' : ''}`}
        style={rootStyle}
      >
        {/* Alertas contextuais têm prioridade sobre a revisão de escrita. */}
        {!minimized && !open && (
          leadEvent
            ? <ProactiveEventBubble
                event={leadEvent}
                name={characterName}
                onAccept={acceptEvent}
                onDismiss={companion.dismissEvent}
                onOpen={() => setOpen(true)}
              />
            : <WritingBubble settings={settings} draft={draft} onApply={onApplyDraft} name={characterName} onPhase={setBubblePhase} />
        )}

        {/* Balão quando minimizado (só a carinha espiando) */}
        {minimized && (
          <button className="cmpMinBubble" onClick={toggleMin} title={`Reativar ${characterName}`}>
            <span className="cmpMinFace" aria-hidden="true"><NinoAvatar state="silencioso" name={characterName} quiet /></span>
            <Moon size={13} /> {characterName} está de soneca
          </button>
        )}

        {/* O personagem */}
        {!minimized && (
          <div
            className="cmpAvatarWrap"
            onPointerDown={onAvatarPointerDown}
            title={`${characterName} — ${STATE_CAPTION[state] || ''}. Clique para abrir, arraste para mover`}
          >
            {(hasCritical || hasWarning) && !busy && <span className={`cmpBadge ${hasCritical ? 'crit' : 'warn'}`}>{unread.length}</span>}
            <NinoAvatar state={quiet && !busy ? 'aguardando' : state} name={characterName} quiet={settings.animationLevel === 'nenhum'} />
          </div>
        )}
      </div>

      {/* Painel do copiloto (Conversa, Memória e Documentos) — aberto pelo
          avatar. Recebe a conversa principal aberta para poder levá-la como
          contexto QUANDO o usuário autorizar, e o compositor para devolver
          texto ao chat principal. */}
      {open && !minimized && (
        <CopilotWorkspace
          copilot={copilot}
          companion={companion}
          state={state}
          conversationId={conversationId}
          conversationTitle={conversationTitle}
          onApplyDraft={onApplyDraft}
          onEventAction={acceptEvent}
          showToast={showToast}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
