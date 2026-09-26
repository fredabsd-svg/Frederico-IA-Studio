import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { ProviderIcon } from './ProviderIcon.jsx';
import { useEscapeLayer } from '../hooks/useEscapeLayer.js';

// Dropdown de "Família" com o logo de cada família — substitui o <select>
// nativo (que não renderiza imagem). Recebe as opções já rotuladas:
//   options = [{ key: 'all', label: 'Todos (339)' }, { key: 'openai', label: 'OpenAI (GPT) (67)' }, ...]
//
// key === 'all' não tem logo; mostra o glifo ≡. As demais passam a família ao
// ProviderIcon (o sufixo "/_" garante que famílias com hífen, como "x-ai" ou
// "z-ai", sejam lidas inteiras).
//
// O menu usa `position: fixed` ancorado ao botão (getBoundingClientRect) para
// ESCAPAR do `overflow:hidden` do `.mpPanel` — o `<select>` nativo antigo era
// desenhado pelo SO e escapava sozinho; um menu em fluxo, não. Além disso, ele
// vira PARA CIMA quando não há espaço abaixo, então a lista nunca é cortada na
// borda inferior do painel nem sai da tela.
//
// Teclado: ↓/↑ no botão abrem a lista já na opção atual; dentro dela, ↓/↑ andam,
// Home/End vão às pontas, Enter/Espaço escolhem (são botões) e Esc fecha SÓ a
// lista — o seletor de modelo em volta continua aberto (ver escapeStack.js).
const MENU_MAX_H = 320; // casa com o max-height do .mpFamPanel no CSS
const GAP = 5;

// O rótulo padrão casa com o texto visível ("Família") do filtro que o usa.
export function FamilySelect({ options, value, onChange, ariaLabel = 'Família' }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const ref = useRef(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  // Ao abrir pelo teclado, a opção atual recebe o foco assim que o menu existir.
  const focusOnOpen = useRef(false);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function close({ refocus = false } = {}) {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }
  useEscapeLayer(open, () => close({ refocus: panelRef.current?.contains(document.activeElement) }));

  const optionButtons = () => [...(panelRef.current?.querySelectorAll('[role="option"]') || [])];
  function focusOption(index) {
    const items = optionButtons();
    if (!items.length) return;
    items[(index + items.length) % items.length].focus();
  }
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const selected = options.findIndex(o => o.key === value);
    focusOption(selected === -1 ? 0 : selected);
  }, [open, menuStyle]);

  function onButtonKeyDown(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    focusOnOpen.current = true;
    if (open) { focusOnOpen.current = false; focusOption(options.findIndex(o => o.key === value)); }
    else setOpen(true);
  }
  function onPanelKeyDown(e) {
    const items = optionButtons();
    const index = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusOption(index + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusOption(index <= 0 ? items.length - 1 : index - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusOption(0); }
    else if (e.key === 'End') { e.preventDefault(); focusOption(items.length - 1); }
    else if (e.key === 'Tab') setOpen(false);
  }

  // Posiciona o menu junto ao botão, virando para cima se faltar espaço embaixo.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const btn = btnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - GAP;
      const spaceAbove = rect.top - GAP;
      const below = spaceBelow >= Math.min(MENU_MAX_H, 200) || spaceBelow >= spaceAbove;
      const maxHeight = Math.max(120, Math.min(MENU_MAX_H, below ? spaceBelow : spaceAbove));
      const base = { position: 'fixed', left: Math.round(rect.left), width: Math.round(rect.width), maxHeight };
      setMenuStyle(below
        ? { ...base, top: Math.round(rect.bottom + GAP) }
        : { ...base, bottom: Math.round(window.innerHeight - rect.top + GAP) });
    }
    place();
    // Fecha em scroll/resize: o menu é fixo e ficaria "solto" do botão que rola junto.
    // A rolagem da PRÓPRIA lista (roda do mouse, ou ↓/↑ levando o foco a uma
    // opção fora da vista) não conta — senão a navegação por teclado fecharia o menu.
    const close = () => setOpen(false);
    const closeOnScroll = e => { if (!panelRef.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', closeOnScroll, true); // captura scroll de contêineres internos
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', closeOnScroll, true); };
  }, [open]);

  const current = options.find(o => o.key === value) || options[0];

  const glyph = (key) => key === 'all'
    ? <span className="mpProvIcon mpProvMono" style={{ width: 22, height: 22 }} aria-hidden="true">≡</span>
    : <ProviderIcon id={`${key}/_`} size={22}/>;

  return <div className="mpFamSelect" ref={ref}>
    <button ref={btnRef} type="button" className={'mpFamBtn ' + (open ? 'on' : '')} aria-haspopup="listbox" aria-expanded={open}
            aria-label={ariaLabel} onClick={() => setOpen(o => !o)} onKeyDown={onButtonKeyDown}>
      {glyph(current?.key)}
      <span className="mpFamBtnText">{current?.label}</span>
      <ChevronDown size={15}/>
    </button>
    {open && <div ref={panelRef} className="mpFamPanel" role="listbox" aria-label={ariaLabel} style={menuStyle || undefined} onKeyDown={onPanelKeyDown}>
      {options.map(opt => (
        <button key={opt.key} type="button" role="option" aria-selected={opt.key === value}
                className={'mpFamOpt ' + (opt.key === value ? 'sel' : '')}
                onClick={() => { onChange(opt.key); close({ refocus: true }); }}>
          {glyph(opt.key)}
          <span className="mpFamOptLabel">{opt.label}</span>
          {opt.key === value && <Check size={14} className="mpFamOptChk"/>}
        </button>
      ))}
    </div>}
  </div>;
}
