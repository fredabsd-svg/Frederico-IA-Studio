import React, { useEffect, useRef, useState } from 'react';
import { Search, ChevronDown, Check, Cpu } from 'lucide-react';

// Ids (ou prefixos) dos modelos mais confiáveis para gerar planilhas/arquivos
const BEST_FOR_FILES = [
  'deepseek/deepseek-chat', 'openai/gpt-4o', 'openai/gpt-4.1',
  'anthropic/claude-sonnet', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-3.7-sonnet',
  'google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'mistralai/mistral-large'
];

// Famílias de modelos (prefixo do id → rótulo amigável)
const FAMILY_META = {
  openai: '🟢 OpenAI (GPT)', anthropic: '🟣 Anthropic (Claude)', google: '🔷 Google (Gemini)',
  deepseek: '🐋 DeepSeek', 'meta-llama': '♾️ Meta (Llama)', mistralai: '🌬️ Mistral',
  'x-ai': '✖️ xAI (Grok)', qwen: '🧧 Qwen', cohere: '🔗 Cohere', amazon: '📦 Amazon (Nova)',
  microsoft: '🪟 Microsoft (Phi)', nvidia: '🟩 NVIDIA', perplexity: '🔎 Perplexity',
  'z-ai': '🇿 Z.AI', moonshotai: '🌙 Moonshot (Kimi)', 'nousresearch': '🧠 Nous'
};
const familyKey = id => { const s = String(id); return s.includes('/') ? s.split('/')[0] : s.split('-')[0]; };
const familyLabel = key => FAMILY_META[key] || ('🤖 ' + (key.charAt(0).toUpperCase() + key.slice(1)));
const NEW_DAYS = 60;
const isNewModel = m => m.created && (Date.now() / 1000 - m.created) < NEW_DAYS * 86400;
const daysAgo = m => Math.max(0, Math.floor((Date.now() / 1000 - m.created) / 86400));
const ctxLabel = n => !n ? '' : n >= 1000 ? `${Math.round(n / 1000)}k contexto` : `${n} contexto`;

// Seletor de modelos com busca, filtros por família, lançamentos e capacidades
export function ModelPicker({ models, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [fam, setFam] = useState('all');       // família selecionada
  const [flags, setFlags] = useState([]);       // toggles ativos
  const [sortNew, setSortNew] = useState(false);// ordenar por lançamento
  const ref = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  useEffect(() => { if (open) { setTimeout(() => searchRef.current?.focus(), 30); } }, [open]);

  const current = models.find(m => m.id === value);
  const query = q.trim().toLowerCase();
  const match = m => !query || (m.name || '').toLowerCase().includes(query) || m.id.toLowerCase().includes(query);
  const isFree = m => m.free || m.id.endsWith(':free');
  const isBest = m => BEST_FOR_FILES.some(p => m.id === p || m.id.startsWith(p));
  const toggleFlag = f => setFlags(fl => fl.includes(f) ? fl.filter(x => x !== f) : [...fl, f]);

  // Famílias presentes, ordenadas por quantidade
  const famCounts = {};
  for (const m of models) { const k = familyKey(m.id); famCounts[k] = (famCounts[k] || 0) + 1; }
  const families = Object.keys(famCounts).sort((a, b) => famCounts[b] - famCounts[a]);

  // Filtros de capacidade (toggles rápidos)
  const FLAGS = [
    { key: 'new', label: '🆕 Lançamentos' },
    { key: 'free', label: '🆓 Grátis' },
    { key: 'tools', label: '🛠️ Geram arquivos' },
    { key: 'vision', label: '👁️ Leem imagens' },
    { key: 'image', label: '🖼️ Criam imagens' },
    { key: 'video', label: '🎬 Criam vídeo' }
  ];
  const passFlags = m =>
    (!flags.includes('new') || isNewModel(m)) &&
    (!flags.includes('free') || isFree(m)) &&
    (!flags.includes('tools') || m.tools !== false) &&
    (!flags.includes('vision') || m.vision) &&
    (!flags.includes('image') || m.image) &&
    (!flags.includes('video') || m.video);
  const passFam = m => fam === 'all' || familyKey(m.id) === fam;

  const base = models.filter(m => match(m) && passFam(m) && passFlags(m));
  const filtersOn = query || fam !== 'all' || flags.length > 0 || sortNew;

  // Com filtro/ordenação: lista única; sem filtro: categorias (visão padrão)
  const flat = filtersOn ? [...base].sort((a, b) => sortNew ? (b.created || 0) - (a.created || 0) : a.name.localeCompare(b.name)) : null;
  const groups = filtersOn ? [] : [
    { label: '⭐ Melhores para planilhas e arquivos', items: base.filter(m => m.tools !== false && !isFree(m) && !m.image && isBest(m)) },
    { label: '🆕 Lançamentos recentes', items: [...base].filter(isNewModel).sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 8) },
    { label: '🖼️ Geram imagens', items: base.filter(m => m.image && !isFree(m)) },
    { label: '🎬 Geram vídeo', items: base.filter(m => m.video) },
    { label: '✅ Outros com ferramentas (geram arquivos)', items: base.filter(m => m.tools !== false && !isFree(m) && !m.image && !m.video && !isBest(m)) },
    { label: '🆓 Gratuitos — sujeitos a fila e limites', items: base.filter(m => isFree(m)) },
    { label: '💬 Só conversa (não geram arquivos)', items: base.filter(m => m.tools === false && !m.image && !m.video && !isFree(m)) }
  ].filter(g => g.items.length);

  function pick(id) { onChange(id); setOpen(false); }
  function clearFilters() { setQ(''); setFam('all'); setFlags([]); setSortNew(false); }

  const row = m => (
    <button key={m.id} className={`mpItem ${m.id === value ? 'sel' : ''}`} onClick={() => pick(m.id)}>
      <span className="mpItemName">{m.name}{isNewModel(m) && <span className="mpNew">NOVO</span>}</span>
      <span className="mpItemId">{m.id}</span>
      <span className="mpItemMeta">{[isNewModel(m) ? `há ${daysAgo(m)} dia(s)` : '', ctxLabel(m.context), isFree(m) ? 'grátis' : ''].filter(Boolean).join(' · ')}</span>
      {m.id === value && <Check size={14} className="mpCheck"/>}
    </button>
  );

  return <div className="mpicker" ref={ref}>
    <button className="mpBtn" onClick={() => setOpen(o => !o)} title="Escolher o modelo de IA">
      <Cpu size={15} className="mpIco"/>
      <span className="mpName">{current?.name || value}</span>
      <ChevronDown size={14}/>
    </button>
    {open && <div className="mpPanel">
      <div className="mpSearch">
        <Search size={14}/>
        <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar modelo pelo nome..."/>
        {filtersOn && <button className="mpClear" onClick={clearFilters} title="Limpar filtros">Limpar</button>}
      </div>
      <div className="mpFilters">
        {FLAGS.map(f => <button key={f.key} className={`mpChip ${flags.includes(f.key) ? 'on' : ''}`} onClick={() => toggleFlag(f.key)}>{f.label}</button>)}
        <button className={`mpChip ${sortNew ? 'on' : ''}`} onClick={() => setSortNew(v => !v)} title="Mostrar os mais novos primeiro">↕️ Mais novos primeiro</button>
      </div>
      <div className="mpFamRow">
        <button className={`mpChip ${fam === 'all' ? 'on' : ''}`} onClick={() => setFam('all')}>Todas as famílias</button>
        {families.map(k => <button key={k} className={`mpChip ${fam === k ? 'on' : ''}`} onClick={() => setFam(k)}>{familyLabel(k)} <em>{famCounts[k]}</em></button>)}
      </div>
      <div className="mpList">
        {filtersOn
          ? (flat.length ? <div className="mpGroup"><div className="mpGroupLabel">{sortNew ? '🆕 Mais novos primeiro' : 'Resultados'} <em>{flat.length}</em></div>{flat.map(row)}</div>
                         : <p className="mpEmpty">Nenhum modelo com esses filtros.</p>)
          : (groups.length ? groups.map(g => <div key={g.label} className="mpGroup"><div className="mpGroupLabel">{g.label} <em>{g.items.length}</em></div>{g.items.map(row)}</div>)
                           : <p className="mpEmpty">Nenhum modelo disponível.</p>)}
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
