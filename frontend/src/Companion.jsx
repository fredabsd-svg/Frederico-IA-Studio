import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Moon, Check, X } from 'lucide-react';
import { API } from './constants.js';
import { useCopilotChat } from './hooks/useCopilotChat.js';
import { CopilotWorkspace } from './components/CopilotWorkspace.jsx';

// Frederico Companion — a representação visual e interativa do Studio (o "colega
// de trabalho digital"). É a CAMADA de experiência: a inteligência vem do núcleo
// do Studio. O avatar agora abre APENAS o painel do copiloto (abas Chat e
// Documentos); a configuração vive em Configurações. Além disso, ele observa o
// que você digita no chat principal e, discretamente, oferece revisar a escrita.

// Uma frase curta que o personagem "diz" em cada estado — transparência sobre o
// que está acontecendo, em vez de um "Pensando..." opaco.
const STATE_CAPTION = {
  disponivel: 'Pronto para ajudar',
  escutando: 'Ouvindo você...',
  pensando: 'Analisando...',
  executando: 'Executando ação...',
  alerta: 'Encontrei algo para você ver',
  erro: 'Algo falhou',
  sucesso: 'Feito!',
  silencioso: 'Modo silencioso',
  ausente: 'De férias',
};

// Parâmetros do balão proativo de revisão de escrita (seção R2). Ajustáveis num
// só lugar. A sensibilidade escolhida pelo usuário controla quão cedo aparece.
const PAUSA_MS = 3000;                 // pausa na digitação antes de se oferecer
const MIN_CHARS = { baixa: 140, media: 80, alta: 40 };
const SNOOZE_MS = 20000;               // silêncio após "Agora não" (por rascunho)
const BUBBLE_PHRASES = [
  'Quer que eu dê uma olhada na escrita?',
  'Posso revisar esse texto rapidinho?',
  'Deixa eu ajustar ortografia e clareza?',
  'Quer uma revisão antes de enviar?',
  'Posso deixar isso mais claro pra você?',
];

// O personagem em si: um "orb" amigável com rosto, desenhado em SVG e animado
// por CSS conforme o estado.
function CompanionAvatar({ state, name, color = '#4f8cff' }) {
  return (
    <div className={`cmpAvatar state-${state}`} aria-label={`${name}: ${STATE_CAPTION[state] || ''}`}>
      <svg viewBox="0 0 100 100" width="100%" height="100%" role="img" aria-hidden="true">
        <defs>
          <radialGradient id="cmpBody" cx="38%" cy="32%" r="75%">
            <stop offset="0%" stopColor={color} stopOpacity="0.95" />
            <stop offset="100%" stopColor={color} stopOpacity="0.55" />
          </radialGradient>
        </defs>
        {/* antena — reage nos estados de escuta/pensamento */}
        <line className="cmpAntenna" x1="50" y1="16" x2="50" y2="4" stroke={color} strokeWidth="3" strokeLinecap="round" />
        <circle className="cmpAntennaDot" cx="50" cy="4" r="4" fill={color} />
        {/* corpo */}
        <circle className="cmpBody" cx="50" cy="56" r="34" fill="url(#cmpBody)" />
        {/* olhos */}
        <g className="cmpEyes" fill="#0b1220">
          <circle className="cmpEye left" cx="39" cy="52" r="5.2" />
          <circle className="cmpEye right" cx="61" cy="52" r="5.2" />
        </g>
        {/* boca — muda conforme humor */}
        <path className="cmpMouth" d="M40 68 Q50 76 60 68" fill="none" stroke="#0b1220" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="cmpPulse" aria-hidden="true" />
    </div>
  );
}

// Balão proativo de revisão de escrita. Observa o rascunho do chat principal e,
// após uma pausa, oferece revisar. Nunca altera nada sozinho — o usuário aceita.
function WritingBubble({ settings, draft, onApply, name }) {
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
            <button className="cmpBubbleYes" onClick={accept}><Check size={13} /> Sim</button>
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

export function Companion({
  companion,
  busy, statusText, listening,
  model, allModels = [], assistants = [],
  draft = '', onApplyDraft,
  showToast,
}) {
  const { settings, persona, events } = companion;
  const copilot = useCopilotChat();
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(() => localStorage.getItem('fred_companion_min') === '1');
  const [pos, setPos] = useState(() => {
    try { const p = JSON.parse(localStorage.getItem('fred_companion_pos') || 'null'); if (p && typeof p.x === 'number') return p; } catch {}
    return null; // null = ancorado no canto inferior direito (CSS)
  });
  const [successFlash, setSuccessFlash] = useState(false);
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const prevBusy = useRef(busy);

  const unread = useMemo(() => events.filter(e => e.status === 'novo' || e.status === 'visto'), [events]);
  const hasCritical = unread.some(e => e.level === 'critico');
  const hasWarning = unread.some(e => e.level === 'aviso');

  // Pequena reação positiva quando uma execução termina (busy: true -> false).
  useEffect(() => {
    if (prevBusy.current && !busy) {
      setSuccessFlash(true);
      const t = setTimeout(() => setSuccessFlash(false), 1600);
      return () => clearTimeout(t);
    }
    prevBusy.current = busy;
  }, [busy]);

  // Máquina de estados visual. A ordem reflete prioridade.
  const state = useMemo(() => {
    if (settings.mode === 'apresentacao') return 'silencioso';
    if (busy) {
      const s = String(statusText || '').toLowerCase();
      return /execut|ferramenta|rodando|tool|comando/.test(s) ? 'executando' : 'pensando';
    }
    if (listening) return 'escutando';
    if (successFlash) return 'sucesso';
    if (hasCritical) return 'erro';
    if (hasWarning || unread.length) return 'alerta';
    return 'disponivel';
  }, [settings.mode, busy, statusText, listening, successFlash, hasCritical, hasWarning, unread.length]);

  // Arrastar o personagem pela tela. Guarda a posição no localStorage.
  function onAvatarPointerDown(e) {
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    let moved = false;
    dragRef.current = { x: rect.left, y: rect.top };
    function move(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      const nx = Math.min(window.innerWidth - 60, Math.max(8, dragRef.current.x + dx));
      const ny = Math.min(window.innerHeight - 60, Math.max(8, dragRef.current.y + dy));
      setPos({ x: nx, y: ny });
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

  const characterName = settings.characterName || 'Luma';
  const personaColor = persona?.color || '#4f8cff';

  function toggleMin() {
    setMinimized(m => { const nv = !m; localStorage.setItem('fred_companion_min', nv ? '1' : '0'); if (nv) setOpen(false); return nv; });
  }

  const rootStyle = pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined;
  const reduced = settings.animationLevel !== 'completo';

  return (
    <>
      <div
        ref={rootRef}
        className={`companionRoot anim-${settings.animationLevel} ${minimized ? 'min' : ''} ${open ? 'open' : ''}`}
        style={rootStyle}
      >
        {/* Balão proativo de revisão de escrita (só quando o painel está fechado). */}
        {!minimized && !open && (
          <WritingBubble settings={settings} draft={draft} onApply={onApplyDraft} name={characterName} />
        )}

        {/* Balão quando minimizado (só o personagem visível) */}
        {minimized && (
          <button className="cmpMinBubble" onClick={toggleMin} title={`Reativar ${characterName}`}>
            <Moon size={14} /> {characterName}
          </button>
        )}

        {/* O personagem */}
        {!minimized && (
          <div className="cmpAvatarWrap" onPointerDown={onAvatarPointerDown} title={`${characterName} — clique para abrir, arraste para mover`}>
            {(hasCritical || hasWarning) && !busy && <span className={`cmpBadge ${hasCritical ? 'crit' : 'warn'}`}>{unread.length}</span>}
            <CompanionAvatar state={reduced && !busy ? 'disponivel' : state} name={characterName} color={personaColor} />
          </div>
        )}
      </div>

      {/* Painel do copiloto (abas Chat e Documentos) — aberto pelo avatar. */}
      {open && !minimized && (
        <CopilotWorkspace copilot={copilot} companion={companion} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
