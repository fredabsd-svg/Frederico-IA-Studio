import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, ChevronsUpDown, Check, Plus, Trash2 } from 'lucide-react';

// "Construtora Marília" -> "CM"
const initials = (name) => (name || '').split(/\s+/).filter(Boolean).slice(0, 2)
  .map(w => w[0]).join('').toUpperCase() || '?';

// Substitui o <select> nativo de cliente. Mesmo padrão de abertura/fechamento
// do ContextPicker (mousedown fora + Escape), para os dois se comportarem igual.
export function ClientPicker({ clients, clientId, onPick, onAdd, onRemove }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  const active = clients.find(c => c.id === clientId);
  return <div className="clientPicker" ref={ref}>
    <button className={`clientBtn ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)}
            aria-expanded={open} aria-haspopup="listbox" title="Cliente / Projeto ativo">
      <span className="clientTile" aria-hidden="true">{active ? initials(active.name) : <FolderOpen size={13}/>}</span>
      <span className="clientName">{active?.name || 'Geral (sem cliente)'}</span>
      <ChevronsUpDown size={14} className="clientChev"/>
    </button>
    {open && <div className="clientPanel" role="listbox">
      <div className="clientOpts">
        <button role="option" aria-selected={!clientId} className={`clientOpt ${!clientId ? 'sel' : ''}`}
                onClick={() => { onPick(''); setOpen(false); }}>
          <span className="clientTile" aria-hidden="true"><FolderOpen size={13}/></span>
          <span className="clientName">Geral (sem cliente)</span>
          {!clientId && <Check size={14}/>}
        </button>
        {clients.map(c => (
          <button key={c.id} role="option" aria-selected={c.id === clientId}
                  className={`clientOpt ${c.id === clientId ? 'sel' : ''}`}
                  onClick={() => { onPick(c.id); setOpen(false); }}>
            <span className="clientTile" aria-hidden="true">{initials(c.name)}</span>
            <span className="clientName">{c.name}</span>
            {c.id === clientId && <Check size={14}/>}
          </button>
        ))}
      </div>
      <div className="clientFoot">
        <button onClick={() => { onAdd(); setOpen(false); }}><Plus size={13}/> Novo cliente</button>
        {clientId && <button className="clientRemove" onClick={() => { onRemove(); setOpen(false); }}><Trash2 size={13}/> Remover</button>}
      </div>
    </div>}
  </div>;
}
