import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { ProviderIcon } from './ProviderIcon.jsx';

// Dropdown de "Fornecedor" com o logo de cada família — substitui o <select>
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
const MENU_MAX_H = 320; // casa com o max-height do .mpFamPanel no CSS
const GAP = 5;

export function FamilySelect({ options, value, onChange, ariaLabel = 'Fornecedor' }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const ref = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

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
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true); // captura scroll de contêineres internos
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [open]);

  const current = options.find(o => o.key === value) || options[0];

  const glyph = (key) => key === 'all'
    ? <span className="mpProvIcon mpProvMono" style={{ width: 22, height: 22 }} aria-hidden="true">≡</span>
    : <ProviderIcon id={`${key}/_`} size={22}/>;

  return <div className="mpFamSelect" ref={ref}>
    <button ref={btnRef} type="button" className={'mpFamBtn ' + (open ? 'on' : '')} aria-haspopup="listbox" aria-expanded={open}
            aria-label={ariaLabel} onClick={() => setOpen(o => !o)}>
      {glyph(current?.key)}
      <span className="mpFamBtnText">{current?.label}</span>
      <ChevronDown size={15}/>
    </button>
    {open && <div className="mpFamPanel" role="listbox" aria-label={ariaLabel} style={menuStyle || undefined}>
      {options.map(opt => (
        <button key={opt.key} type="button" role="option" aria-selected={opt.key === value}
                className={'mpFamOpt ' + (opt.key === value ? 'sel' : '')}
                onClick={() => { onChange(opt.key); setOpen(false); }}>
          {glyph(opt.key)}
          <span className="mpFamOptLabel">{opt.label}</span>
          {opt.key === value && <Check size={14} className="mpFamOptChk"/>}
        </button>
      ))}
    </div>}
  </div>;
}
