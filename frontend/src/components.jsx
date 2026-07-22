import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, ChevronDown, Check, Cpu, Star, SlidersHorizontal, X, Wrench, Eye, Image as ImageIcon, Brain, Video, MessageSquare } from 'lucide-react';
import { ProviderIcon } from './components/ProviderIcon.jsx';
import { FamilySelect } from './components/FamilySelect.jsx';
import { findRanking, tierClass } from './modelRanking.js';

// Ids (ou prefixos) dos modelos mais confiáveis para gerar planilhas/arquivos
const BEST_FOR_FILES = [
  'deepseek/deepseek-chat', 'openai/gpt-4o', 'openai/gpt-4.1',
  'anthropic/claude-sonnet', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-3.7-sonnet',
  'google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'mistralai/mistral-large'
];
const GENERAL_RECOMMENDATIONS = [
  'anthropic/claude-sonnet', 'openai/gpt-4.1', 'openai/gpt-4o',
  'google/gemini-2.5-pro', 'google/gemini-2.5-flash',
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-chat', 'mistralai/mistral-large'
];

// Famílias de modelos (prefixo do id → rótulo amigável)
const FAMILY_META = {
  openai: 'OpenAI (GPT)', anthropic: 'Anthropic (Claude)', google: 'Google (Gemini)',
  deepseek: 'DeepSeek', 'meta-llama': 'Meta (Llama)', mistralai: 'Mistral',
  'x-ai': 'xAI (Grok)', qwen: 'Qwen', cohere: 'Cohere', amazon: 'Amazon (Nova)',
  microsoft: 'Microsoft (Phi)', nvidia: 'NVIDIA', perplexity: 'Perplexity',
  'z-ai': 'Z.AI', moonshotai: 'Moonshot (Kimi)', 'nousresearch': 'Nous'
};
const familyKey = id => { const s = String(id); return s.includes('/') ? s.split('/')[0] : s.split('-')[0]; };
const familyLabel = key => FAMILY_META[key] || (key.charAt(0).toUpperCase() + key.slice(1));
const BIG_CTX = 100000;
const ctxLabel = n => !n ? '' : n >= 1000 ? `${Math.round(n / 1000)}k contexto` : `${n} contexto`;
const priceLabel = m => m.free ? 'grátis' : (m.price ? `$${(m.price * 1e6).toFixed(2)}/1M` : '');
const FAV_KEY = 'fred_fav_models';
const RECENT_KEY = 'fred_recent_models';
const loadStoredIds = key => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};
const loadFavs = () => loadStoredIds(FAV_KEY);
const loadRecent = () => loadStoredIds(RECENT_KEY);

const capabilityOf = (model, key) => {
  const declared = model?.capabilities;
  if (declared && Object.prototype.hasOwnProperty.call(declared, key)) return declared[key];
  return model?.[key];
};

function ModelCapabilitySummary({ model }) {
  const text = capabilityOf(model, 'text');
  const tools = capabilityOf(model, 'tools');
  const entries = [];

  if (text === false) entries.push({ key: 'text', label: 'Sem texto', Icon: MessageSquare, tone: 'no' });
  else if (tools === false) entries.push({ key: 'text-only', label: 'Somente texto', Icon: MessageSquare, tone: 'no' });
  else if (tools === true) entries.push({ key: 'tools', label: 'Ferramentas', Icon: Wrench, tone: 'yes' });
  else entries.push({ key: 'text', label: 'Texto', Icon: MessageSquare, tone: 'neutral' });

  if (capabilityOf(model, 'vision') === true) entries.push({ key: 'vision', label: 'Visão', Icon: Eye, tone: 'yes' });
  if (capabilityOf(model, 'image') === true) entries.push({ key: 'image', label: 'Imagem', Icon: ImageIcon, tone: 'yes' });
  if (capabilityOf(model, 'reasoning') === true) entries.push({ key: 'reasoning', label: 'Raciocínio', Icon: Brain, tone: 'yes' });
  if (capabilityOf(model, 'video') === true) entries.push({ key: 'video', label: 'Vídeo', Icon: Video, tone: 'yes' });

  return <span className="mpItemCaps" aria-label="Capacidades do modelo">
    {entries.map(({ key, label, Icon, tone }) => <span key={key} className={`mpCap ${tone}`} title={label}><Icon size={12}/><span>{label}</span></span>)}
  </span>;
}


// A escolha começa pelo trabalho que a pessoa quer fazer. O catálogo e os filtros
// detalhados ficam disponíveis sem transformar a primeira tela numa taxonomia.
//
// `inline`: renderiza só o corpo do painel, sem botão nem popover próprio, para
// que o ContextPicker possa embuti-lo como uma aba. Popover dentro de popover
// confunde o foco e o clique-fora — por isso a separação.
export function ModelPicker({ models, value, onChange, inline = false, onPicked }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState('recommended');
  const [purpose, setPurpose] = useState('general');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fam, setFam] = useState('all');
  const [flags, setFlags] = useState([]);
  const [sort, setSort] = useState('none');
  const [favs, setFavs] = useState(loadFavs);
  const [recent, setRecent] = useState(loadRecent);
  const ref = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => {
    if (open && !inline) setTimeout(() => searchRef.current?.focus(), 30);
  }, [open, inline]);

  const current = models.find(model => model.id === value);
  const query = q.trim().toLowerCase();
  const match = model => !query || (model.name || '').toLowerCase().includes(query) || model.id.toLowerCase().includes(query);
  const isFree = model => model.free || model.id.endsWith(':free');
  const isBest = model => BEST_FOR_FILES.some(prefix => model.id === prefix || model.id.startsWith(prefix));
  const isRecommended = model => GENERAL_RECOMMENDATIONS.some(prefix => model.id === prefix || model.id.startsWith(prefix));
  const isFav = id => favs.includes(id);
  const priceValue = model => isFree(model) ? 0 : model.price || Infinity;
  // Modelo sem classificação vai para o fim ao ordenar por "Minha classificação".
  const rankValue = model => findRanking(model)?.rank ?? Infinity;
  const purposes = [
    { id: 'general', label: 'Trabalho geral', description: 'Conversa, análise e produção do dia a dia.', matches: model => (isRecommended(model) || model.id === value) && capabilityOf(model, 'tools') !== false && !model.image && !model.video },
    { id: 'files', label: 'Documentos e planilhas', description: 'Modelos com ferramentas confirmadas para criar arquivos.', matches: model => capabilityOf(model, 'tools') === true && isBest(model) },
    { id: 'economy', label: 'Economia', description: 'Opções grátis e de menor custo.', matches: model => isFree(model) || Boolean(model.price) },
    { id: 'vision', label: 'Analisar imagens', description: 'Modelos que leem imagens e documentos visuais.', matches: model => model.vision },
    { id: 'image', label: 'Criar imagens', description: 'Modelos com geração de imagens.', matches: model => model.image },
    { id: 'video', label: 'Criar vídeo', description: 'Modelos com geração de vídeo.', matches: model => model.video }
  ];
  const advancedFilters = [
    { key: 'free', label: 'Apenas grátis' },
    { key: 'ctx', label: 'Contexto amplo' },
    { key: 'tools', label: 'Ferramentas' },
    { key: 'vision', label: 'Lê imagens' },
    { key: 'image', label: 'Cria imagens' },
    { key: 'video', label: 'Cria vídeo' }
  ];
  const selectedPurpose = purposes.find(item => item.id === purpose) || purposes[0];
  const toggleFlag = key => setFlags(active => active.includes(key) ? active.filter(item => item !== key) : [...active, key]);

  function toggleFav(id, event) {
    event?.stopPropagation();
    setFavs(previous => {
      const next = previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id];
      try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function rememberModel(id) {
    setRecent(previous => {
      const next = [id, ...previous.filter(item => item !== id)].slice(0, 5);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function pick(id) {
    rememberModel(id);
    onChange(id);
    setOpen(false);
    onPicked?.(id);
  }

  const famCounts = {};
  for (const model of models) {
    const key = familyKey(model.id);
    famCounts[key] = (famCounts[key] || 0) + 1;
  }
  const families = Object.keys(famCounts).sort((a, b) => famCounts[b] - famCounts[a]);
  const passFlags = model =>
    (!flags.includes('free') || isFree(model)) &&
    (!flags.includes('ctx') || (model.context || 0) >= BIG_CTX) &&
    (!flags.includes('tools') || capabilityOf(model, 'tools') !== false) &&
    (!flags.includes('vision') || model.vision) &&
    (!flags.includes('image') || model.image) &&
    (!flags.includes('video') || model.video);
  const filteredModels = models.filter(model => match(model) && (fam === 'all' || familyKey(model.id) === fam) && passFlags(model));
  const activeFilterCount = flags.length + Number(fam !== 'all') + Number(sort !== 'none');
  const sortFn = (a, b) => sort === 'new' ? (b.created || 0) - (a.created || 0)
    : sort === 'cheap' ? priceValue(a) - priceValue(b)
    : sort === 'rank' ? rankValue(a) - rankValue(b)
    : String(a.name || a.id).localeCompare(String(b.name || b.id));
  const generalRecommendationRank = model => {
    const index = GENERAL_RECOMMENDATIONS.findIndex(prefix => model.id === prefix || model.id.startsWith(prefix));
    return index === -1 ? GENERAL_RECOMMENDATIONS.length : index;
  };
  const recommendedSort = (a, b) => {
    if (purpose === 'economy') return priceValue(a) - priceValue(b);
    const score = model => (model.id === value ? 4 : 0) + (isFav(model.id) ? 2 : 0) + (purpose === 'files' && isBest(model) ? 1 : 0);
    return score(b) - score(a) || (purpose === 'general' ? generalRecommendationRank(a) - generalRecommendationRank(b) : String(a.name || a.id).localeCompare(String(b.name || b.id)));
  };
  const recentModels = recent
    .map(id => models.find(model => model.id === id))
    .filter(Boolean)
    .filter(model => filteredModels.some(item => item.id === model.id) && selectedPurpose.matches(model))
    .slice(0, 3);
  const recentIds = new Set(recentModels.map(model => model.id));
  const matchingPurposeModels = filteredModels.filter(selectedPurpose.matches);
  const recommendationFamily = model => {
    const curatedPrefixes = purpose === 'general' ? GENERAL_RECOMMENDATIONS : purpose === 'files' ? BEST_FOR_FILES : [];
    return curatedPrefixes.find(prefix => model.id === prefix || model.id.startsWith(prefix)) || familyKey(model.id);
  };
  const familyRepresentativeSort = (a, b) => purpose === 'economy'
    ? priceValue(a) - priceValue(b) || (b.created || 0) - (a.created || 0)
    : (b.created || 0) - (a.created || 0) || String(b.name || b.id).localeCompare(String(a.name || a.id));
  const diverseRecommendedModels = [...matchingPurposeModels]
    .sort(familyRepresentativeSort)
    .filter((model, index, items) => !items.slice(0, index).some(previous => recommendationFamily(previous) === recommendationFamily(model)));
  const recommendedModels = diverseRecommendedModels
    .filter(model => !recentIds.has(model.id))
    .sort(sort === 'none' ? recommendedSort : sortFn)
    .slice(0, 6);
  const favoriteModels = [...filteredModels].filter(model => isFav(model.id)).sort(sortFn);
  const catalogModels = [...filteredModels].sort(sortFn);
  const displayView = query ? 'search' : view;

  const row = model => {
    const ranking = findRanking(model);
    return (
    <div key={model.id} className={'mpItem ' + (model.id === value ? 'sel' : '')}>
      <ProviderIcon id={model.id} size={28}/>
      <button className="mpPick" onClick={() => pick(model.id)}>
        <span className="mpItemName">
          {model.name}
          {ranking && <span className={`mpRank ${tierClass(ranking.tier)}`} title={`Classificação de referência: #${ranking.rank} de 100 · Tier ${ranking.tier}`}>{ranking.tier}</span>}
          {model.id === value && <Check size={13} className="mpInlineCheck" aria-label="Modelo em uso"/>}
        </span>
        <span className="mpItemId">{model.id}</span>
        <span className="mpItemMeta">{[ctxLabel(model.context), priceLabel(model)].filter(Boolean).join(' · ')}</span>
        <ModelCapabilitySummary model={model}/>
      </button>
      <button className={'mpStar ' + (isFav(model.id) ? 'on' : '')} onClick={event => toggleFav(model.id, event)} title={isFav(model.id) ? 'Remover dos favoritos' : 'Adicionar aos favoritos'} aria-label={isFav(model.id) ? 'Remover dos favoritos' : 'Adicionar aos favoritos'} aria-pressed={isFav(model.id)}><Star size={14} fill={isFav(model.id) ? 'currentColor' : 'none'}/></button>
    </div>
    );
  };
  const section = (title, items, empty) => <section className="mpSection">
    <div className="mpSectionHead"><span>{title}</span><em>{items.length}</em></div>
    {items.length ? items.map(row) : <p className="mpEmpty">{empty}</p>}
  </section>;

  const panel = <div className={inline ? 'mpPanel mpPanelInline' : 'mpPanel'}>
      <div className="mpSearch">
        <Search size={14}/>
        <input ref={searchRef} value={q} onChange={event => setQ(event.target.value)} placeholder="Buscar modelo pelo nome" aria-label="Buscar modelo pelo nome"/>
        {q && <button className="mpSearchClear" onClick={() => setQ('')} title="Limpar busca" aria-label="Limpar busca"><X size={14}/></button>}
      </div>
      <div className="mpPrimaryControls">
        <label className="mpPurposeField">
          <span>Objetivo</span>
          <select value={purpose} onChange={event => { setPurpose(event.target.value); setView('recommended'); }}>
            {purposes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <button className={'mpFilterToggle ' + (filtersOpen || activeFilterCount ? 'on' : '')} onClick={() => setFiltersOpen(isVisible => !isVisible)} aria-expanded={filtersOpen} title="Abrir filtros avançados">
          <SlidersHorizontal size={15}/><span>Filtros</span>{activeFilterCount > 0 && <b>{activeFilterCount}</b>}
        </button>
      </div>
      <div className="mpViewTabs" role="tablist" aria-label="Navegação de modelos">
        {[['recommended', 'Recomendados'], ['favorites', 'Favoritos (' + favs.length + ')'], ['catalog', 'Catálogo']].map(([id, label]) => <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>{label}</button>)}
      </div>
      {filtersOpen && <div className="mpAdvanced" aria-label="Filtros avançados">
        <div className="mpAdvancedHead"><span>Refinar catálogo</span>{activeFilterCount > 0 && <button onClick={() => { setFam('all'); setFlags([]); setSort('none'); }}>Limpar filtros</button>}</div>
        <div className="mpAdvancedFields">
          <label>Fornecedor
            <FamilySelect
              value={fam}
              onChange={setFam}
              options={[
                { key: 'all', label: `Todos (${models.length})` },
                ...families.map(key => ({ key, label: `${familyLabel(key)} (${famCounts[key]})` }))
              ]}
            />
          </label>
          <label>Ordenar
            <select value={sort} onChange={event => setSort(event.target.value)}>
              <option value="none">Nome do modelo</option>
              <option value="new">Lançamentos</option>
              <option value="cheap">Menor custo</option>
              <option value="rank">Classificação de referência</option>
            </select>
          </label>
        </div>
        <div className="mpFilterChecks" role="group" aria-label="Capacidades">
          {advancedFilters.map(filter => <label key={filter.key}><input type="checkbox" checked={flags.includes(filter.key)} onChange={() => toggleFlag(filter.key)}/><span>{filter.label}</span></label>)}
        </div>
      </div>}
      <div className="mpList" role="tabpanel">
        {displayView === 'search' && section('Resultados para "' + q.trim() + '"', catalogModels, 'Nenhum modelo encontrado com esta busca.')}
        {displayView === 'recommended' && <>
          <div className="mpPurposeHint"><strong>{selectedPurpose.label}</strong><span>{selectedPurpose.description}</span></div>
          {recentModels.length > 0 && section('Usados recentemente', recentModels, '')}
          {section(purpose === 'general' || purpose === 'files' ? 'Sugestões' : 'Modelos compatíveis', recommendedModels, 'Nenhum modelo atende a este objetivo com os filtros atuais.')}
          <button className="mpCatalogLink" onClick={() => setView('catalog')}>Ver catálogo completo ({catalogModels.length})</button>
        </>}
        {displayView === 'favorites' && section('Favoritos', favoriteModels, 'Adicione modelos aos favoritos para acessá-los rapidamente.')}
        {displayView === 'catalog' && section('Catálogo', catalogModels, 'Nenhum modelo atende aos filtros atuais.')}
      </div>
    </div>;

  if (inline) return panel;

  return <div className="mpicker" ref={ref}>
    <button className="mpBtn" onClick={() => setOpen(isOpen => !isOpen)} title="Escolher o modelo de IA" aria-expanded={open}>
      <Cpu size={15} className="mpIco"/>
      <span className="mpName">{current?.name || value}</span>
      <ChevronDown size={14}/>
    </button>
    {open && panel}
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

function useDialogFocus(ref, onClose) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement;
    const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const target = ref.current?.querySelector('[data-autofocus]') || ref.current?.querySelector(selector) || ref.current;
      target?.focus();
    };
    const frame = requestAnimationFrame(focusFirst);

    function onKey(e) {
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
      if (dialogs.at(-1) !== ref.current) return;
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current?.(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...(ref.current?.querySelectorAll(selector) || [])];
      if (!focusable.length) { e.preventDefault(); ref.current?.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [ref]);
}

function DialogShell({ title, icon, onClose, children, variant = 'modal', className = '' }) {
  const ref = useRef(null);
  useDialogFocus(ref, onClose);
  const overlayClass = variant === 'drawer' ? 'drawerOverlay' : 'modalOverlay';
  const panelClass = variant === 'drawer' ? `drawer ${className}` : `modal ${className}`;

  return <div className={overlayClass} onMouseDown={onClose}>
    <section ref={ref} className={panelClass} onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <div className="modalHead">
        <h2>{icon} {title}</h2>
        <button className="x" onClick={onClose} aria-label="Fechar" title="Fechar"><X size={18}/></button>
      </div>
      <div className="modalBody">{children}</div>
    </section>
  </div>;
}

// Casca para tarefas curtas e decisões contextuais.
export function Modal({ title, icon, onClose, children, className }) {
  return <DialogShell title={title} icon={icon} onClose={onClose} className={className}>{children}</DialogShell>;
}

// Gaveta para tarefas de média duração que precisam preservar o contexto do chat.
export function Drawer({ title, icon, onClose, children, className }) {
  return <DialogShell title={title} icon={icon} onClose={onClose} variant="drawer" className={className}>{children}</DialogShell>;
}

function ConfirmDialog({ title = 'Confirmar ação', message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', destructive, onConfirm, onClose }) {
  return <Modal title={title} onClose={onClose} className="decisionDialog">
    <p className="dialogCopy">{message}</p>
    <div className="modalActions">
      <div className="spacer"/>
      <button onClick={onClose} data-autofocus>{cancelLabel}</button>
      <button className={destructive ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </Modal>;
}

function PromptDialog({ title = 'Preencher informação', label = 'Valor', initialValue = '', confirmLabel = 'Salvar', onConfirm, onClose }) {
  const [value, setValue] = useState(initialValue);
  function submit(e) { e.preventDefault(); onConfirm(value); }
  return <Modal title={title} onClose={onClose} className="decisionDialog">
    <form className="dialogForm" onSubmit={submit}>
      <label>{label}
        <input value={value} onChange={e => setValue(e.target.value)} data-autofocus autoComplete="off"/>
      </label>
      <div className="modalActions">
        <div className="spacer"/>
        <button type="button" onClick={onClose}>Cancelar</button>
        <button className="primary" type="submit">{confirmLabel}</button>
      </div>
    </form>
  </Modal>;
}

// Substitui prompt/confirm do navegador por decisões consistentes com o app.
export function useAppDialog() {
  const [request, setRequest] = useState(null);
  const askConfirm = useCallback(options => new Promise(resolve => setRequest({ kind: 'confirm', ...options, resolve })), []);
  const askPrompt = useCallback(options => new Promise(resolve => setRequest({ kind: 'prompt', ...options, resolve })), []);
  const finish = useCallback(value => {
    request?.resolve(value);
    setRequest(null);
  }, [request]);

  const dialog = request?.kind === 'confirm'
    ? <ConfirmDialog {...request} onClose={() => finish(false)} onConfirm={() => finish(true)}/>
    : request?.kind === 'prompt'
      ? <PromptDialog {...request} onClose={() => finish(null)} onConfirm={value => finish(value)}/>
      : null;

  return { askConfirm, askPrompt, dialog };
}
