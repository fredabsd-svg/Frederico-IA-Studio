import React, { useCallback, useEffect, useRef, useState } from 'react';

// Nino — o personagem do copiloto. Substitui o antigo "orb" com antena do
// CompanionAvatar. É só APRESENTAÇÃO: quem decide o estado continua sendo o
// Companion.jsx (busy / statusText / listening / events), exatamente como antes.
//
// Anatomia: corpo super-arredondado em terracota, broto de folha no topo (humor),
// olhos grandes que acompanham o cursor, bochechas coradas, boca com 6 formas e
// um halo que comunica urgência sem texto. Toda animação usa só transform e
// opacity; o nível "reduzido/nenhum" entra pela prop `quiet`.

export const NINO_CAPTION = {
  aguardando: 'por aqui quando precisar',
  observando: 'tô acompanhando',
  pensando: 'deixa eu pensar um pouco',
  analisando: 'lendo as informações com calma',
  digitando: 'escrevendo pra você',
  comemorando: 'prontinho! ficou bom',
  erro: 'deu ruim aqui — te explico',
  sugestao: 'tive uma ideia',
  duvida: 'me confirma uma coisa?',
  silencioso: 'modo silencioso, sem sustos',
};

// eyes: normal | wide | happy | squint | x    mouth: smile | grin | flat | wavy | o | talk
const MAP = {
  aguardando:  { eyes: 'normal', mouth: 'smile', anim: 'ninoFloat 3.6s ease-in-out infinite', color: '#c67139', halo: 0 },
  observando:  { eyes: 'wide',   mouth: 'smile', anim: 'ninoFloat 4.4s ease-in-out infinite', color: '#c67139', halo: 0.55 },
  pensando:    { eyes: 'squint', mouth: 'flat',  anim: 'ninoThink 1.5s ease-in-out infinite', color: '#7a8a5e', halo: 0.7, prop: 'dots' },
  analisando:  { eyes: 'normal', mouth: 'flat',  anim: 'ninoFloat 2.4s ease-in-out infinite', color: '#4f8cff', halo: 0.75, prop: 'ring' },
  digitando:   { eyes: 'normal', mouth: 'talk',  anim: 'ninoBob .95s ease-in-out infinite',   color: '#4f8cff', halo: 0.5, prop: 'typing' },
  comemorando: { eyes: 'happy',  mouth: 'grin',  anim: 'ninoHop .66s cubic-bezier(.3,1.4,.5,1) 3', color: '#7a8a5e', halo: 0.9, prop: 'confetti' },
  erro:        { eyes: 'x',      mouth: 'wavy',  anim: 'ninoShake .55s ease-in-out 2',        color: '#ef4444', halo: 1, prop: 'bang' },
  sugestao:    { eyes: 'wide',   mouth: 'grin',  anim: 'ninoPulse 1.7s ease-in-out infinite', color: '#f5a623', halo: 0.9, prop: 'sparks' },
  duvida:      { eyes: 'squint', mouth: 'o',     anim: 'ninoTilt 2.6s ease-in-out infinite',  color: '#f5a623', halo: 0.6, prop: 'question' },
  silencioso:  { eyes: 'squint', mouth: 'flat',  anim: 'ninoFloat 7s ease-in-out infinite',   color: '#94a3b8', halo: 0 },
};

const PHRASES = ['Oi!', 'Cutucou!', 'Tô aqui', 'Diz aí', 'Ei!', 'Prontinho', 'Hihi'];
const POKE = { eyes: 'happy', mouth: 'grin', prop: 'confetti', anim: 'ninoBoing .62s cubic-bezier(.34,1.56,.64,1)' };

function Eyes({ mode }) {
  if (mode === 'happy') {
    return (
      <g fill="none" stroke="#2b1c11" strokeWidth="4.6" strokeLinecap="round">
        <path d="M36 66 Q44 56 52 66" />
        <path d="M68 66 Q76 56 84 66" />
      </g>
    );
  }
  if (mode === 'squint') {
    return (
      <g fill="none" stroke="#2b1c11" strokeWidth="4.6" strokeLinecap="round">
        <path d="M36.5 63 Q44 68.5 51.5 63" />
        <path d="M68.5 63 Q76 68.5 83.5 63" />
      </g>
    );
  }
  if (mode === 'x') {
    return (
      <g fill="none" stroke="#2b1c11" strokeWidth="4.4" strokeLinecap="round">
        <path d="M38.5 58.5 L49.5 69.5 M49.5 58.5 L38.5 69.5" />
        <path d="M70.5 58.5 L81.5 69.5 M81.5 58.5 L70.5 69.5" />
      </g>
    );
  }
  const wide = mode === 'wide';
  const ry = wide ? 11.4 : 9.6;
  const rx = wide ? 9.4 : 8.2;
  const cy = wide ? 63 : 64;
  return (
    <>
      <g fill="#2b1c11">
        <ellipse cx="44" cy={cy} rx={rx} ry={ry} />
        <ellipse cx="76" cy={cy} rx={rx} ry={ry} />
      </g>
      <g fill="#ffffff">
        <circle cx={wide ? 41 : 41.4} cy={wide ? 58.8 : 60.4} r={wide ? 3.5 : 3} opacity="0.93" />
        <circle cx={wide ? 73 : 73.4} cy={wide ? 58.8 : 60.4} r={wide ? 3.5 : 3} opacity="0.93" />
        <circle cx={wide ? 47.6 : 47} cy="67.6" r={wide ? 1.8 : 1.5} opacity="0.58" />
        <circle cx={wide ? 79.6 : 79} cy="67.6" r={wide ? 1.8 : 1.5} opacity="0.58" />
      </g>
    </>
  );
}

function Mouth({ mode, quiet }) {
  switch (mode) {
    case 'grin':
      return (
        <>
          <path d="M47 84 Q60 101 73 84 Z" fill="#2b1c11" />
          <path d="M55 94.5 Q60 99.5 65 94.5 Z" fill="#e2846c" />
        </>
      );
    case 'flat':
      return <path d="M52.5 88 L67.5 88" fill="none" stroke="#2b1c11" strokeWidth="4.2" strokeLinecap="round" />;
    case 'wavy':
      return <path d="M48 89 q4.5 -5.5 9 0 t9 0" fill="none" stroke="#2b1c11" strokeWidth="4" strokeLinecap="round" />;
    case 'o':
      return <circle cx="60" cy="89" r="5.2" fill="#2b1c11" />;
    case 'talk':
      return <ellipse className={quiet ? '' : 'ninoTalkMouth'} cx="60" cy="89" rx="7" ry="6.4" fill="#2b1c11" />;
    default:
      return <path d="M50 86 Q60 94.5 70 86" fill="none" stroke="#2b1c11" strokeWidth="4.2" strokeLinecap="round" />;
  }
}

function Prop({ kind, quiet }) {
  switch (kind) {
    case 'dots':
      return (
        <g fill="currentColor">
          <circle className="ninoDot" cx="99" cy="42" r="3" />
          <circle className="ninoDot d2" cx="107" cy="32" r="4" />
          <circle className="ninoDot d3" cx="113" cy="19" r="5.4" />
        </g>
      );
    case 'ring':
      if (quiet) return null;
      return <circle className="ninoRing" cx="60" cy="70" r="52" fill="none" stroke="currentColor" strokeWidth="2.4" strokeDasharray="7 12" strokeLinecap="round" opacity="0.6" />;
    case 'typing':
      return (
        <g>
          <rect x="88" y="24" width="36" height="21" rx="10.5" fill="#f5ead8" />
          <path d="M92 44 L88 50 L96 45 Z" fill="#f5ead8" />
          <g fill="#b25a29">
            <circle className="ninoDot" cx="97" cy="34.5" r="2.6" />
            <circle className="ninoDot d2" cx="106" cy="34.5" r="2.6" />
            <circle className="ninoDot d3" cx="115" cy="34.5" r="2.6" />
          </g>
        </g>
      );
    case 'sparks':
      return (
        <g className="ninoSparks" stroke="#f5a623" strokeWidth="3.4" strokeLinecap="round">
          <path d="M83 -6 L83 -13" />
          <path d="M97 3 L104 -1" />
          <path d="M97 17 L104 21" />
          <path d="M95 -8 L100 -13" />
          <path d="M69 -6 L67 -13" />
        </g>
      );
    case 'confetti':
      return (
        <g>
          <circle className="ninoSpark" cx="12" cy="46" r="4" fill="#7a8a5e" />
          <circle className="ninoSpark s2" cx="108" cy="52" r="4.6" fill="#c67139" />
          <circle className="ninoSpark s3" cx="28" cy="16" r="3.4" fill="#f5a623" />
          <circle className="ninoSpark s4" cx="96" cy="14" r="3.8" fill="#7a8a5e" />
          <circle className="ninoSpark s5" cx="18" cy="88" r="3.2" fill="#f5a623" />
          <circle className="ninoSpark s6" cx="104" cy="90" r="3.6" fill="#c67139" />
        </g>
      );
    case 'question':
      return <text className="ninoGlyph" x="100" y="30" fontSize="30" fill="currentColor">?</text>;
    case 'bang':
      return <text className="ninoGlyph fast" x="100" y="30" fontSize="30" fill="currentColor">!</text>;
    default:
      return null;
  }
}

export function NinoAvatar({ state = 'aguardando', name = 'Nino', quiet = false }) {
  const rootRef = useRef(null);
  const followRef = useRef(null);
  const blinkRef = useRef(null);
  const centerRef = useRef(null);
  const pokeTimer = useRef(null);
  const [poked, setPoked] = useState(false);
  const [phrase, setPhrase] = useState('');

  const base = MAP[state] || MAP.aguardando;
  const cfg = poked ? { ...base, ...POKE } : base;

  // Olhar que acompanha o cursor: um único listener passivo, com o centro do
  // personagem em cache (recalculado só em scroll/resize). Move apenas o grupo
  // dos olhos — sem re-render do React e sem recalcular layout a cada pixel.
  useEffect(() => {
    if (quiet) return undefined;
    const measure = () => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      centerRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const move = (e) => {
      const g = followRef.current, c = centerRef.current;
      if (!g || !c) return;
      const dx = Math.max(-1, Math.min(1, (e.clientX - c.x) / 260));
      const dy = Math.max(-1, Math.min(1, (e.clientY - c.y) / 260));
      g.style.transform = `translate(${(dx * 3.6).toFixed(2)}px,${(dy * 2.8).toFixed(2)}px)`;
    };
    measure();
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('scroll', measure, { passive: true, capture: true });
    window.addEventListener('resize', measure, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('scroll', measure, { capture: true });
      window.removeEventListener('resize', measure);
    };
  }, [quiet]);

  // Piscada espontânea — é o que faz o personagem parecer vivo parado.
  useEffect(() => {
    if (quiet) return undefined;
    const id = setInterval(() => {
      const g = blinkRef.current;
      if (!g || document.hidden) return;
      g.style.transition = 'transform .09s ease';
      g.style.transform = 'scaleY(.08)';
      setTimeout(() => { if (g) g.style.transform = 'scaleY(1)'; }, 130);
    }, 4200 + Math.random() * 2600);
    return () => clearInterval(id);
  }, [quiet]);

  useEffect(() => () => clearTimeout(pokeTimer.current), []);

  // Cutucar: reação a qualquer pointerdown no personagem. NÃO consome o evento —
  // o Companion continua tratando arrastar/abrir no mesmo pointerdown.
  const poke = useCallback(() => {
    clearTimeout(pokeTimer.current);
    setPhrase(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
    setPoked(true);
    pokeTimer.current = setTimeout(() => setPoked(false), 1100);
  }, []);

  const anim = quiet && !poked ? 'ninoFloat 8s ease-in-out infinite' : cfg.anim;
  const halo = quiet ? Math.min(cfg.halo, 0.4) : cfg.halo;

  return (
    <div
      ref={rootRef}
      className={`ninoRoot state-${state}${poked ? ' poked' : ''}`}
      style={{ color: cfg.color }}
      onPointerDown={poke}
      aria-label={`${name}: ${NINO_CAPTION[state] || ''}`}
    >
      <svg viewBox="0 0 120 142" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">
        <defs>
          <linearGradient id="ninoBody" x1="20%" y1="4%" x2="80%" y2="100%">
            <stop offset="0%" stopColor="#ffdcb6" />
            <stop offset="40%" stopColor="#eb9f5f" />
            <stop offset="100%" stopColor="#b25a29" />
          </linearGradient>
          <radialGradient id="ninoGloss" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.72" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="ninoLeaf" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#adc088" />
            <stop offset="100%" stopColor="#6c7c51" />
          </linearGradient>
          <radialGradient id="ninoShadowG" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1a1008" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#1a1008" stopOpacity="0" />
          </radialGradient>
        </defs>

        <ellipse cx="60" cy="133" rx="27" ry="6" fill="url(#ninoShadowG)" />

        <g className="ninoHalo" style={{ opacity: halo }}>
          <circle cx="60" cy="72" r="50" fill="none" stroke="currentColor" strokeWidth="15" opacity="0.13" />
          <circle cx="60" cy="72" r="41" fill="none" stroke="currentColor" strokeWidth="9" opacity="0.16" />
        </g>

        <g className="ninoBody" style={{ animation: anim }}>
          <g className="ninoSprout">
            <path d="M60 28 C57 18 60.5 10.5 67 6.5" fill="none" stroke="#6c7c51" strokeWidth="4.8" strokeLinecap="round" />
            <path d="M67 6.5 C71.5 -0.8 83 0.2 86.8 7.8 C89.4 13.6 81.6 19 74.8 15.4 C70.2 12.9 66.2 10.6 67 6.5 Z" fill="url(#ninoLeaf)" />
            <path d="M70.5 10 C75.5 10.6 80.5 10 84.5 7.8" fill="none" stroke="#f5ead8" strokeWidth="1.7" strokeLinecap="round" opacity="0.4" />
          </g>

          <rect x="17" y="26" width="86" height="86" rx="40" fill="url(#ninoBody)" />
          <ellipse cx="45" cy="49" rx="25" ry="16" fill="url(#ninoGloss)" transform="rotate(-18 45 49)" />
          <path d="M22 84 C26 106 42 112 60 112 C78 112 94 106 98 84" fill="none" stroke="#ffffff" strokeWidth="3.6" strokeLinecap="round" opacity="0.16" />
          <ellipse cx="31" cy="81" rx="8.6" ry="4.8" fill="#a83c1e" opacity="0.26" />
          <ellipse cx="89" cy="81" rx="8.6" ry="4.8" fill="#a83c1e" opacity="0.26" />

          <g ref={followRef}>
            <g ref={blinkRef} className="ninoEyes">
              <Eyes mode={cfg.eyes} />
            </g>
          </g>

          <Mouth mode={cfg.mouth} quiet={quiet} />
        </g>

        <Prop kind={cfg.prop} quiet={quiet} />
      </svg>

      {poked && phrase && <span className="ninoPhrase">{phrase}</span>}
    </div>
  );
}
