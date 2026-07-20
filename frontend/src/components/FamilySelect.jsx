import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { ProviderIcon } from './ProviderIcon.jsx';

// Dropdown de "Fornecedor" com o logo de cada família — substitui o <select>
// nativo (que não renderiza imagem). Recebe as opções já rotuladas:
//   options = [{ key: 'all', label: 'Todos (339)' }, { key: 'openai', label: 'OpenAI (GPT) (67)' }, ...]
//
// key === 'all' não tem logo; mostra o glifo ≡. As demais passam a família ao
// ProviderIcon (o sufixo "/_" garante que famílias com hífen, como "x-ai" ou
// "z-ai", sejam lidas inteiras).
export function FamilySelect({ options, value, onChange, ariaLabel = 'Fornecedor' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  const current = options.find(o => o.key === value) || options[0];

  const glyph = (key) => key === 'all'
    ? <span className="mpProvIcon mpProvMono" style={{ width: 22, height: 22 }} aria-hidden="true">≡</span>
    : <ProviderIcon id={`${key}/_`} size={22}/>;

  return <div className="mpFamSelect" ref={ref}>
    <button type="button" className={'mpFamBtn ' + (open ? 'on' : '')} aria-haspopup="listbox" aria-expanded={open}
            aria-label={ariaLabel} onClick={() => setOpen(o => !o)}>
      {glyph(current?.key)}
      <span className="mpFamBtnText">{current?.label}</span>
      <ChevronDown size={15}/>
    </button>
    {open && <div className="mpFamPanel" role="listbox" aria-label={ariaLabel}>
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
