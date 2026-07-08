import React, { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown, Check } from 'lucide-react';

// Ids (ou prefixos) dos modelos mais confiáveis para gerar planilhas/arquivos
const BEST_FOR_FILES = [
  'deepseek/deepseek-chat', 'openai/gpt-4o', 'openai/gpt-4.1',
  'anthropic/claude-sonnet', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-3.7-sonnet',
  'google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'mistralai/mistral-large'
];

// Seletor de modelos com busca e categorias
export function ModelPicker({ models, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  useEffect(() => { if (open) { setQ(''); setTimeout(() => searchRef.current?.focus(), 30); } }, [open]);

  const current = models.find(m => m.id === value);
  const query = q.trim().toLowerCase();
  const match = m => !query || (m.name || '').toLowerCase().includes(query) || m.id.toLowerCase().includes(query);
  const isFree = m => m.id.endsWith(':free');
  const isBest = m => BEST_FOR_FILES.some(p => m.id === p || m.id.startsWith(p));

  const groups = [
    { label: '⭐ Melhores para planilhas e arquivos', items: models.filter(m => m.tools !== false && !isFree(m) && !m.image && isBest(m)) },
    { label: '🖼️ Geram imagens', items: models.filter(m => m.image && !isFree(m)) },
    { label: '🎬 Geram vídeo', items: models.filter(m => m.video) },
    { label: '✅ Outros com ferramentas (geram arquivos)', items: models.filter(m => m.tools !== false && !isFree(m) && !m.image && !m.video && !isBest(m)) },
    { label: '🆓 Gratuitos — sujeitos a fila e limites', items: models.filter(m => isFree(m)) },
    { label: '💬 Só conversa (não geram arquivos)', items: models.filter(m => m.tools === false && !m.image && !m.video && !isFree(m)) }
  ].map(g => ({ ...g, items: g.items.filter(match) })).filter(g => g.items.length);

  function pick(id) { onChange(id); setOpen(false); }

  return <div className="mpicker" ref={ref}>
    <button className="mpBtn" onClick={() => setOpen(o => !o)} title="Escolher o modelo de IA">
      <span className="mpName">{current?.name || value}</span>
      <ChevronDown size={14}/>
    </button>
    {open && <div className="mpPanel">
      <div className="mpSearch">
        <Search size={14}/>
        <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar modelo pelo nome..."/>
      </div>
      <div className="mpList">
        {groups.length === 0 && <p className="mpEmpty">Nenhum modelo encontrado para "{q}".</p>}
        {groups.map(g => <div key={g.label} className="mpGroup">
          <div className="mpGroupLabel">{g.label} <em>{g.items.length}</em></div>
          {g.items.map(m => (
            <button key={`${g.label}-${m.id}`} className={`mpItem ${m.id === value ? 'sel' : ''}`} onClick={() => pick(m.id)}>
              <span className="mpItemName">{m.name}</span>
              <span className="mpItemId">{m.id}</span>
              {m.id === value && <Check size={14} className="mpCheck"/>}
            </button>
          ))}
        </div>)}
      </div>
    </div>}
  </div>;
}

// Chip de ferramenta em execução/concluída dentro de uma mensagem.
// Clique expande e mostra o que foi executado e o resultado.
export function ToolStep({ step }) {
  const [open, setOpen] = useState(false);
  const end = step.ended || Date.now();
  const secs = Math.max(0, Math.round((end - step.started) / 1000));
  const hasDetail = !!(step.preview || step.result);
  return <div className="toolwrap">
    <button className={`toolstep ${step.status}`} onClick={() => hasDetail && setOpen(o => !o)} title={hasDetail ? 'Clique para ver o que foi executado' : undefined}>
      <span className="ic">{step.status === 'running' ? <span className="spin sm"/> : '✓'}</span>
      <code>{step.name}</code>
      <span className="sec">{secs}s</span>
      {step.status === 'running' && <span className="lbl">executando…</span>}
      {hasDetail && <ChevronDown size={12} className={`tchev ${open ? 'up' : ''}`}/>}
    </button>
    {open && <pre className="tooldetail">{step.preview ? `▶ Executado:\n${step.preview}` : ''}{step.preview && step.result ? '\n\n' : ''}{step.result ? `◀ Resultado:\n${step.result}` : ''}</pre>}
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

// Mensagens longas ficam recolhidas com botão "Mostrar tudo"
export function Collapsible({ text, limit = 700, children }) {
  const [open, setOpen] = useState(false);
  const t = text || '';
  if (t.length <= limit) return children(t);
  return <div className="clamp">
    {children(open ? t : t.slice(0, limit).trimEnd() + '…')}
    <button className="clampBtn" onClick={() => setOpen(o => !o)}>
      {open ? '▲ Recolher' : `▼ Mostrar tudo (${(t.length / 1000).toFixed(1)} mil caracteres)`}
    </button>
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
