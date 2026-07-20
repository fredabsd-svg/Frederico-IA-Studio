import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Download, FileText, FileSpreadsheet, FilePenLine, Plus, ArrowUp, Upload, Moon, Sun, Trash2, Settings, Bot, Brain, X, BarChart3, Users, Pause, Play, Square, Mic, Globe, Menu, RefreshCw, Sparkles, Copy, Check, Pencil, BookMarked, BookmarkPlus, FileDown, HardDriveDownload, Hourglass, ListTodo, FolderCog, Search, PanelLeft, Wrench, CalendarClock, Inbox, Palette, Gauge, SlidersHorizontal, Paperclip, MoreHorizontal, FolderOpen, Code2, Cpu, ChevronDown, ChevronRight, ChevronsUpDown, Calculator, Telescope, Scale, Briefcase, Receipt, Landmark, Megaphone, Lightbulb, ShieldCheck, GraduationCap, Stethoscope, Hammer, Leaf, LogOut, KeyRound, Camera, Cable } from 'lucide-react';
import { API, FALLBACK_MODELS, TOOL_INFO, TEMPLATES, QUICK_ACTIONS, THEMES, WORKSPACES, EFFORTS, EFFORT_DESC, emptyForm, ASSISTANT_ICONS, ASSISTANT_COLORS, isAssistantIcon } from './constants.js';
import { signOut } from './authClient.js';
import { ToolStep, Slider, Modal, Drawer, ModelPicker, Collapsible, useAppDialog } from './components.jsx';
import { MemoryPanel } from './MemoryPanel.jsx';
import { PcFoldersPanel } from './PcFoldersPanel.jsx';
import { ToolsPanel } from './ToolsPanel.jsx';
import { DeveloperPanel } from './DeveloperPanel.jsx';
import { RoutinesPanel } from './RoutinesPanel.jsx';
import { InboxPanel } from './InboxPanel.jsx';
import { ProviderPanel } from './ProviderPanel.jsx';
import { ConnectorsPanel } from './ConnectorsPanel.jsx';
import { PrivacyPanel, ConsentGate } from './PrivacyPanel.jsx';
import { CameraCapture } from './CameraCapture.jsx';
import { takeSseEvents } from './sse.js';

const QUICK_ACTION_ICON = {
  document: FileText,
  spreadsheet: FileSpreadsheet,
  writing: FilePenLine,
  search: Search,
  plan: ListTodo,
  build: Code2,
  review: Check,
  folder: FolderCog
};

const WORKSPACE_ICON = {
  studio: Bot,
  essential: SlidersHorizontal,
  focus: Sparkles,
  developer: Code2
};

// Mapa explícito em vez de Lucide[nome] sobre `import * as Lucide`: o import
// estrela puxaria os ~1500 ícones da biblioteca para o bundle, porque mata o
// tree-shaking. As chaves espelham ASSISTANT_ICONS em constants.js.
const ASSISTANT_ICON = {
  'bot': Bot,
  'calculator': Calculator,
  'file-pen-line': FilePenLine,
  'code-2': Code2,
  'telescope': Telescope,
  'scale': Scale,
  'briefcase': Briefcase,
  'bar-chart-3': BarChart3,
  'receipt': Receipt,
  'landmark': Landmark,
  'megaphone': Megaphone,
  'lightbulb': Lightbulb,
  'shield-check': ShieldCheck,
  'graduation-cap': GraduationCap,
  'stethoscope': Stethoscope,
  'hammer': Hammer,
  'leaf': Leaf
};

const assistantColor = (a, i = 0) => a?.color || ASSISTANT_COLORS[i % ASSISTANT_COLORS.length];

// ---- Data e hora das mensagens ----
const parseDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
const msgTime = (v) => parseDate(v)?.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) || '';
const dayKey = (v) => parseDate(v)?.toDateString() || '';
const conversationDownloadUrl = (conversationId, filePath) => {
  const encodedId = encodeURIComponent(String(conversationId || ''));
  const encodedPath = String(filePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${API}/api/conversations/${encodedId}/download/${encodedPath}`;
};
function dayLabel(v) {
  const d = parseDate(v);
  if (!d) return '';
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hoje';
  if (d.toDateString() === yesterday.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
  });
}

// Desenha o ícone do assistente. Se o valor não for um nome de ícone conhecido,
// é um emoji de um assistente criado antes da migração: imprime como texto.
function AssistantGlyph({ value, size = 14 }) {
  const Icon = ASSISTANT_ICON[value];
  if (Icon) return <Icon size={size}/>;
  return <span className="glyphEmoji" style={{ fontSize: size }}>{value || '🤖'}</span>;
}

// Ladrilho colorido do assistente (ContextPicker e cabeçalho das mensagens).
function AssistantTile({ assistant, index = 0, size = 26, icon = 14 }) {
  const color = assistantColor(assistant, index);
  return <span className="asstTile" style={{
    width: size, height: size, color,
    background: `color-mix(in srgb, ${color} 16%, transparent)`
  }}>
    <AssistantGlyph value={assistant?.emoji} size={icon}/>
  </span>;
}

// "Construtora Marília" -> "CM"
const initials = (name) => (name || '').split(/\s+/).filter(Boolean).slice(0, 2)
  .map(w => w[0]).join('').toUpperCase() || '?';

// Substitui o <select> nativo de cliente. Mesmo padrão de abertura/fechamento
// do ContextPicker (mousedown fora + Escape), para os dois se comportarem igual.
function ClientPicker({ clients, clientId, onPick, onAdd, onRemove }) {
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

const DEVELOPER_QUICK_ACTIONS = [
  { icon: 'plan', label: 'Planejar uma mudança', desc: 'Entenda o projeto antes de editar', mode: 'plan' },
  { icon: 'build', label: 'Construir com segurança', desc: 'Aplique alterações no projeto escolhido', mode: 'build' },
  { icon: 'review', label: 'Revisar alterações', desc: 'Encontre riscos antes de concluir', mode: 'review' },
  { icon: 'folder', label: 'Conectar um projeto', desc: 'Escolha as pastas liberadas no computador', action: 'folders' }
];

const modelCapability = (model, key) => {
  const declared = model?.capabilities;
  if (declared && Object.prototype.hasOwnProperty.call(declared, key)) return declared[key];
  return model?.[key];
};
const modelHasTools = model => modelCapability(model, 'tools') !== false;
const toolResultFailed = content => {
  try {
    const result = JSON.parse(content);
    return Boolean(result?.error) || (typeof result?.exitCode === 'number' && result.exitCode !== 0);
  } catch {
    return false;
  }
};
const modelCompatibilityLabel = (model) => {
  if (modelCapability(model, 'text') === false) return 'sem chat em texto';
  if (modelCapability(model, 'tools') === false) return 'somente texto';
  if (modelCapability(model, 'tools') === true) return 'com ferramentas';
  return 'texto';
};

// Controle único de contexto da barra superior.
//
// Antes: rótulo do espaço de trabalho + ModelPicker + botão Equipe + <select> de
// assistente + engrenagem de editar — quatro controles lado a lado para a mesma
// pergunta ("quem responde?"), sendo que ligar a Equipe desabilitava os vizinhos
// sem explicar por quê.
//
// Agora: um botão, três abas. A aba É o modo — abrir "Equipe" liga a equipe,
// abrir "Assistente" desliga. Nada é desabilitado, porque nada compete.
function ContextPicker({ models, model, onModel, assistants, assistantId, onPickAssistant,
                         currentAssistant, team, onTeam, teamIds, onToggleMember,
                         effectiveTeam, onEditAssistant }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(team ? 'team' : 'assistant');
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  useEffect(() => { setTab(t => (team && t === 'assistant') ? 'team' : (!team && t === 'team') ? 'assistant' : t); }, [team]);

  const currentModel = models.find(m => m.id === model);
  const who = team
    ? `Equipe (${effectiveTeam.length})`
    : (currentAssistant?.name || 'Assistente');

  function goTab(id) {
    setTab(id);
    if (id === 'team') onTeam(true);
    if (id === 'assistant') onTeam(false);
  }

  return <div className="ctxPicker" ref={ref}>
    <button className={`ctxBtn ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}
            title="Quem responde e com qual modelo de IA">
      {team ? <Users size={15}/> : <AssistantGlyph value={currentAssistant?.emoji} size={15}/>}
      <span className="ctxBtnText">
        <b>{who}</b>
        <small>{currentModel?.name || model}{currentModel && ` · ${modelCompatibilityLabel(currentModel)}`}</small>
      </span>
      <ChevronDown size={14}/>
    </button>
    {open && <div className="ctxPanel">
      <div className="ctxTabs" role="tablist" aria-label="Contexto da conversa">
        <button role="tab" aria-selected={tab === 'assistant'} className={tab === 'assistant' ? 'on' : ''} onClick={() => goTab('assistant')}><Bot size={14}/> Assistente</button>
        <button role="tab" aria-selected={tab === 'team'} className={tab === 'team' ? 'on' : ''} onClick={() => goTab('team')}><Users size={14}/> Equipe</button>
        <button role="tab" aria-selected={tab === 'model'} className={tab === 'model' ? 'on' : ''} onClick={() => setTab('model')}><Cpu size={14}/> Modelo</button>
      </div>

      {tab === 'assistant' && <div className="ctxBody" role="tabpanel">
        <p className="ctxHint">Um assistente responde sozinho, com a memória e as ferramentas dele.</p>
        <div className="ctxList">
          {assistants.map((a, i) => (
            <button key={a.id} className={`ctxItem ${!team && a.id === assistantId ? 'sel' : ''}`}
                    onClick={() => { onPickAssistant(a.id); onTeam(false); }}>
              <AssistantTile assistant={a} index={i}/>
              <span className="ctxItemName">{a.name}</span>
              {!team && a.id === assistantId && <Check size={14} className="ctxItemChk"/>}
            </button>
          ))}
        </div>
        <button className="ctxFoot" onClick={onEditAssistant}><Settings size={14}/> Editar este assistente</button>
      </div>}

      {tab === 'team' && <div className="ctxBody" role="tabpanel">
        <p className="ctxHint">Vários assistentes respondem à <b>1ª mensagem</b> e um coordenador junta as perspectivas. Depois ele segue sozinho, para reduzir custo e tempo.</p>
        <div className="ctxList">
          {assistants.map((a, i) => {
            const on = !teamIds || teamIds.includes(a.id);
            return <label key={a.id} className={`ctxItem ctxCheck ${on ? 'sel' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => onToggleMember(a.id)}/>
              <AssistantTile assistant={a} index={i}/>
              <span className="ctxItemName">{a.name}</span>
            </label>;
          })}
        </div>
        {effectiveTeam.length === 0 && <p className="ctxWarn">Selecione ao menos um assistente.</p>}
      </div>}

      {tab === 'model' && <div className="ctxBody ctxBodyModel" role="tabpanel">
        <ModelPicker models={models} value={model} onChange={onModel} inline/>
      </div>}
    </div>}
  </div>;
}

function MemoryTrace({ memory, onOpenMemory }) {
  if (!memory?.enabled) return null;
  const stats = memory.stats || {};
  const memories = stats.memoriesUsed ?? memory.memories?.length ?? 0;
  const chunks = stats.chunksUsed ?? memory.chunks?.length ?? 0;
  const summaries = stats.summariesUsed ?? memory.summaries ?? 0;
  const used = stats.contextTokens || memory.usedTokens || 0;
  const budget = stats.contextBudget || memory.budget || 0;
  if (memory.retrievalSkipped === 'low_signal') return <div className="memoryTrace compact"><Brain size={13}/> Memória não foi consultada nesta saudação.</div>;
  const hasSignal = memories || chunks || summaries || memory.history?.clipped;
  if (!hasSignal) return <div className="memoryTrace compact"><Brain size={13}/> Memoria ativa: nada relevante foi adicionado nesta resposta.</div>;
  return <details className="memoryTrace">
    <summary><Brain size={13}/><span>Usei {memories} memoria(s), {chunks} conversa(s) antiga(s){summaries ? ` e ${summaries} resumo(s)` : ''}.</span></summary>
    <div className="memoryTraceBody">
      <div className="memoryTraceMeta">Contexto: {used.toLocaleString('pt-BR')} / {budget.toLocaleString('pt-BR')} tokens{memory.truncated ? ' (encurtado)' : ''}. Historico: {memory.history?.included || 0} mensagens.</div>
      {memory.memories?.length > 0 && <div className="memoryTraceList">
        <b>Memorias usadas</b>
        {memory.memories.slice(0, 8).map((m, i) => <span key={`${m.id || i}-${i}`}>{m.scopeLabel || 'Memoria'} · {m.type || 'nota'} · {m.preview}</span>)}
      </div>}
      {memory.chunks?.length > 0 && <div className="memoryTraceList">
        <b>Conversas antigas</b>
        {memory.chunks.slice(0, 5).map((c, i) => <span key={`${c.title || i}-${i}`}>{c.scopeLabel || 'Escopo'} · {c.title}{c.date ? ` · ${c.date}` : ''}</span>)}
      </div>}
      <button type="button" onClick={(e) => { e.preventDefault(); onOpenMemory?.(); }}>Abrir memoria</button>
    </div>
  </details>;
}

export default function App({ user } = {}) {
  const [conversations, setConversations] = useState([]);
  const [allConvs, setAllConvs] = useState([]);
  const [current, setCurrent] = useState(null);
  const [messages, setMessages] = useState([]);
  const [files, setFiles] = useState([]);
  const [input, setInput] = useState('');
  const [allModels, setAllModels] = useState(FALLBACK_MODELS);
  const [model, setModel] = useState(FALLBACK_MODELS[0].id);
  const [assistants, setAssistants] = useState([]);
  const [assistantId, setAssistantId] = useState(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [pcOpen, setPcOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [developerSession, setDeveloperSession] = useState(null);
  const [developerStartMode, setDeveloperStartMode] = useState('plan');
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  // LGPD: true quando o usuário ainda não aceitou a versão vigente dos
  // Termos/Política (login social, conta antiga ou termos atualizados) —
  // nesse caso um modal bloqueante pede o aceite antes de liberar o app.
  const [needsConsent, setNeedsConsent] = useState(false);
  const [team, setTeam] = useState(false);
  const [teamIds, setTeamIds] = useState(() => { try { return JSON.parse(localStorage.getItem('fred_team') || 'null'); } catch { return null; } });
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [controlPending, setControlPending] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [nowTick, setNowTick] = useState(0);
  const [theme, setTheme] = useState(() => localStorage.getItem('fred_theme') || 'dark');
  const [workspace, setWorkspace] = useState(() => {
    const saved = localStorage.getItem('fred_workspace');
    return WORKSPACES.some(item => item.id === saved) ? saved : 'studio';
  });
  const [themeOpen, setThemeOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [effort, setEffort] = useState(() => { const s = localStorage.getItem('fred_effort'); return EFFORTS.some(e => e.id === s) ? s : 'medio'; });
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const cmpChipsRef = useRef(null);
  const fileInputRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sideHidden, setSideHidden] = useState(() => localStorage.getItem('fred_workspace') === 'focus' || localStorage.getItem('fred_side_hidden') === '1');
  const [convFilter, setConvFilter] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [scanOk, setScanOk] = useState(false); // "✓ verificado pelo antivírus" após upload escaneado
  const [cameraOpen, setCameraOpen] = useState(false);
  const [me, setMe] = useState(null); // { email, isAdmin, pcFoldersEnabled }
  const [loadingConv, setLoadingConv] = useState(false);
  const [connError, setConnError] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [unprotected, setUnprotected] = useState(false);
  const [authWarnHidden, setAuthWarnHidden] = useState(() => localStorage.getItem('fred_authwarn_hidden') === '1');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [toast, setToast] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState(() => localStorage.getItem('fred_client') || '');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const [topActionsOpen, setTopActionsOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const prevTasksRef = useRef([]);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const topActionsRef = useRef(null);
  const sideScrollRef = useRef(null);
  const toastTimer = useRef(null);
  const copyTimer = useRef(null);
  const dragDepth = useRef(0);
  const busyRef = useRef(false);
  const creatingConvRef = useRef(null);
  const currentRef = useRef(null);
  const { askConfirm, askPrompt, dialog: appDialog } = useAppDialog();
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { currentRef.current = current; }, [current]);
  function setChatBusy(next) {
    busyRef.current = next;
    setBusy(next);
  }
  function blockConversationChange() {
    if (!busyRef.current) return false;
    showToast('Há uma resposta em andamento. Aguarde terminar ou pare o processamento antes de trocar de conversa.');
    return true;
  }
  useEffect(() => { localStorage.setItem('fred_effort', effort); }, [effort]);
  useEffect(() => {
    // O painel de esforço vive dentro da linha de chips, então basta uma
    // checagem: clicou fora dela, fecha.
    function onDoc(e) {
      if (!cmpChipsRef.current?.contains(e.target)) setComposerMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  // Ajusta a altura do campo de mensagem também quando o texto muda por código
  // (envio limpa; template/edição preenchem).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (input) el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [input]);

  useEffect(() => { init(); }, []);
  // LGPD: verifica se o aceite da versão vigente dos termos já foi registrado.
  useEffect(() => {
    let ativo = true;
    fetch(`${API}/api/consent`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (ativo && d) setNeedsConsent(!!d.needsConsent); })
      .catch(() => {});
    return () => { ativo = false; };
  }, []);
  useEffect(() => {
    const t = THEMES.find(x => x.id === theme) || THEMES[0];
    document.body.className = `${t.mode} t-${t.id}`;
    localStorage.setItem('fred_theme', t.id);
    localStorage.setItem('fred_workspace', workspace);
  }, [theme, workspace]);
  useEffect(() => {
    const resetSidebarScroll = () => {
      if (sideScrollRef.current) sideScrollRef.current.scrollTop = 0;
    };
    resetSidebarScroll();
    const frame = window.requestAnimationFrame(resetSidebarScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [workspace]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  // Enquanto processa, "bate um relógio" a cada segundo para os contadores vivos
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNowTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  // Fecha o painel da equipe ao clicar fora
  useEffect(() => {
    function onDoc(e) { if (topActionsRef.current && !topActionsRef.current.contains(e.target)) setTopActionsOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Membros ativos da equipe (null = todos)
  const effectiveTeam = assistants.filter(a => !teamIds || teamIds.includes(a.id));
  function toggleTeamMember(id) {
    const cur = teamIds || assistants.map(a => a.id);
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    setTeamIds(next);
    localStorage.setItem('fred_team', JSON.stringify(next));
  }

  function showToast(text, kind = 'err') {
    clearTimeout(toastTimer.current);
    setToast({ text, kind });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }

  // ---- Fila de tarefas ----
  const tasksActive = tasks.some(t => t.status === 'queued' || t.status === 'running');
  useEffect(() => {
    if (!tasksActive && !tasksOpen) return;
    const iv = setInterval(pollTasks, 4000);
    return () => clearInterval(iv);
  }, [tasksActive, tasksOpen, current?.id]);

  async function pollTasks() {
    try {
      const rows = await (await fetch(`${API}/api/tasks`)).json();
      for (const r of rows) {
        const old = prevTasksRef.current.find(p => p.id === r.id);
        if (old && (old.status === 'queued' || old.status === 'running')) {
          if (r.status === 'done') {
            showToast(`✅ Tarefa concluída: ${r.prompt.slice(0, 60)}`, 'ok');
            // Só recarrega se NÃO estiver com uma resposta em andamento na tela,
            // senão o setMessages substituiria o stream ao vivo e ele "sumiria".
            if (r.conversation_id === current?.id && !busyRef.current) { openConversation(current.id); }
          }
          if (r.status === 'error') showToast(`⚠️ Tarefa falhou: ${(r.error || '').slice(0, 100)}`);
        }
      }
      prevTasksRef.current = rows;
      setTasks(rows);
    } catch {}
  }

  async function sendAsTask() {
    const text = input.trim();
    if (!text) return;
    if (busyRef.current) { showToast('Aguarde a resposta atual terminar antes de enviar uma tarefa em segundo plano.'); return; }
    let conv = current;
    if (!conv) { conv = await ensureConversation(); if (!conv) return; }
    if (listening) recognitionRef.current?.stop();
    setInput('');
    try {
      const res = await fetch(`${API}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: conv.id, message: text, model, assistantId, webSearch }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível criar a tarefa.');
      showToast('⏳ Tarefa adicionada à fila — acompanhe no botão "Tarefas".', 'ok');
      await pollTasks();
    } catch (err) { showToast(err.message || 'Não foi possível criar a tarefa.'); }
  }

  async function cancelTask(id) {
    try { await fetch(`${API}/api/tasks/${id}/cancel`, { method: 'POST' }); await pollTasks(); } catch {}
  }

  async function copyMessage(m, idx) {
    try {
      await navigator.clipboard.writeText(m.content || '');
      clearTimeout(copyTimer.current);
      setCopiedIdx(idx);
      copyTimer.current = setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      showToast('Não foi possível copiar (permita o acesso à área de transferência).');
    }
  }

  // ---- Templates de pedido ----
  async function loadTemplates() {
    try { const d = await (await fetch(`${API}/api/templates`)).json(); setTemplates(Array.isArray(d) ? d : []); } catch {}
  }
  function openTemplates() { loadTemplates(); setTplOpen(true); }
  function useTemplate(t) { setInput(t.content); setTplOpen(false); inputRef.current?.focus(); }
  async function saveAsTemplate(m) {
    const name = await askPrompt({
      title: 'Salvar template',
      label: 'Nome do template',
      initialValue: (m.content || '').slice(0, 40),
      confirmLabel: 'Salvar template'
    });
    if (!name?.trim()) return;
    try {
      await fetch(`${API}/api/templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), content: m.content }) });
      showToast(`Template "${name.trim()}" salvo! Acesse em Templates, na barra lateral.`);
    } catch { showToast('Não foi possível salvar o template.'); }
  }
  async function deleteTemplate(id, e) {
    e.stopPropagation();
    const confirmed = await askConfirm({
      title: 'Excluir template',
      message: 'Este template será removido da sua biblioteca. Essa ação não pode ser desfeita.',
      confirmLabel: 'Excluir template',
      destructive: true
    });
    if (!confirmed) return;
    try { await fetch(`${API}/api/templates/${id}`, { method: 'DELETE' }); await loadTemplates(); } catch {}
  }

  // ---- Exportar conversa ----
  async function exportConv(format) {
    setExportOpen(false);
    if (!current || !messages.length) { showToast('A conversa ainda não tem mensagens para exportar.'); return; }
    setExporting(true);
    try {
      const res = await fetch(`${API}/api/conversations/${current.id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '');
      window.open(conversationDownloadUrl(current.id, data.path), '_blank');
    } catch (e) {
      showToast(`Não foi possível exportar: ${e.message || 'erro inesperado'}`);
    } finally {
      setExporting(false);
    }
  }

  async function editMessage(m, idx) {
    const isSaved = m.id && !String(m.id).startsWith('local-');
    if (isSaved) {
      const confirmed = await askConfirm({
        title: 'Editar e regravar a conversa?',
        message: 'Esta mensagem e tudo o que veio depois serão removidos para que a conversa seja regravada a partir daqui.',
        confirmLabel: 'Continuar',
        destructive: true
      });
      if (!confirmed) return;
      try {
        const res = await fetch(`${API}/api/conversations/${current.id}/truncate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: m.id }) });
        if (!res.ok) throw new Error();
        setMessages(prev => prev.slice(0, idx));
        loadFiles();
      } catch {
        showToast('Não foi possível editar a mensagem.');
        return;
      }
    }
    setInput(m.content || '');
    inputRef.current?.focus();
  }

  async function init() {
    setConnError(false);
    try {
      await fetchConversations();   // carrega o histórico na barra lateral
      startNewChat();               // abre sempre na tela de boas-vindas (nunca a última conversa)
      loadModels();
      loadAssistants();
      loadClients();
      try { const h = await (await fetch(`${API}/api/health`)).json(); setUnprotected(h && h.auth === false); } catch {}
      try { const m = await (await fetch(`${API}/api/me`)).json(); setMe(m || null); } catch {}
    } catch (err) {
      if (err?.auth) setNeedLogin(true);
      else setConnError(true);
    }
  }

  // Esconde/mostra a barra lateral (guardado entre sessões)
  function toggleSide() {
    setSideHidden(h => { localStorage.setItem('fred_side_hidden', h ? '0' : '1'); return !h; });
  }

  function changeWorkspace(next) {
    if (!WORKSPACES.some(item => item.id === next)) return;
    setWorkspace(next);
    setMenuOpen(false);
    setTopActionsOpen(false);
    if (next === 'focus') {
      setSideHidden(true);
      localStorage.setItem('fred_side_hidden', '1');
    } else if (workspace === 'focus') {
      setSideHidden(false);
      localStorage.setItem('fred_side_hidden', '0');
    }
  }

  function openDeveloper(mode = 'plan') {
    setDeveloperStartMode(mode);
    setDeveloperOpen(true);
  }

  function handleWelcomeAction(action) {
    if (action.mode) {
      openDeveloper(action.mode);
      return;
    }
    if (action.action === 'folders') {
      setPcOpen(true);
      return;
    }
    setInput(action.prompt || '');
    setTimeout(() => inputRef.current?.focus(), 60);
  }

  // Abre um "app embutido": nova conversa com o pedido guiado já preenchido
  function pickTool(app) {
    setToolsOpen(false);
    if (!startNewChat()) return;
    setInput(app.prompt);
    if (app.needsFile) showToast('Agora anexe o(s) arquivo(s) no botão Anexar e clique em Enviar.', 'ok');
    setTimeout(() => inputRef.current?.focus(), 60);
  }

  // Tela de boas-vindas (conversa "em rascunho" — só vira registro ao 1º envio)
  function startNewChat() {
    if (blockConversationChange()) return false;
    setCurrent(null);
    setMessages([]);
    setFiles([]);
    setInput('');
    setDeveloperSession(null);
    setMenuOpen(false);
    setFilesDrawerOpen(false);
    setTopActionsOpen(false);
    return true;
  }

  function startDeveloperTask({ mode, projectId, github, brief, rules }) {
    const developerAssistant = assistants.find(assistant => /programa|codigo|codex|desenvolv/i.test(`${assistant.name || ''} ${assistant.system_prompt || ''}`)) || assistants[0];
    if (!startNewChat()) return;
    setTeam(false);
    setWebSearch(false);
    if (developerAssistant) pickAssistant(developerAssistant.id);
    setDeveloperSession({ mode, projectId, github: github || null, rules, conversationId: null });
    setInput(brief);
    setDeveloperOpen(false);
    setTimeout(() => inputRef.current?.focus(), 60);
    showToast('Tarefa de desenvolvimento pronta para enviar.', 'ok');
  }

  // ---- Clientes / Projetos ----
  async function loadClients() {
    try { const d = await (await fetch(`${API}/api/clients`)).json(); setClients(Array.isArray(d) ? d : []); } catch {}
  }
  async function switchClient(id) {
    if (blockConversationChange()) return;
    localStorage.setItem('fred_client', id);
    setClientId(id);
    try {
      await fetchConversations(id);
      startNewChat();
    } catch {}
  }
  async function addClient() {
    const name = await askPrompt({
      title: 'Novo cliente ou projeto',
      label: 'Nome',
      confirmLabel: 'Criar cliente'
    });
    if (!name?.trim()) return;
    try {
      const c = await (await fetch(`${API}/api/clients`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) })).json();
      await loadClients();
      if (c?.id) switchClient(c.id);
    } catch { showToast('Não foi possível criar o cliente.'); }
  }
  async function removeClient() {
    if (!clientId) return;
    const c = clients.find(x => x.id === clientId);
    const confirmed = await askConfirm({
      title: `Remover ${c?.name || 'este cliente'}?`,
      message: 'As conversas não serão apagadas: elas voltarão para Geral.',
      confirmLabel: 'Remover cliente',
      destructive: true
    });
    if (!confirmed) return;
    try {
      await fetch(`${API}/api/clients/${clientId}`, { method: 'DELETE' });
      await loadClients();
      switchClient('');
    } catch { showToast('Não foi possível remover o cliente.'); }
  }

  async function doLogin(e) {
    e?.preventDefault();
    setLoginError('');
    try {
      const res = await fetch(`${API}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setLoginError(data.error || 'Senha incorreta.'); return; }
      setPassword('');
      setNeedLogin(false);
      init();
    } catch {
      setLoginError('Não foi possível conectar ao servidor.');
    }
  }

  async function loadModels() {
    try {
      const res = await fetch(`${API}/api/models`);
      const data = await res.json();
      if (data.models?.length) {
        setAllModels(data.models);
        setModel(prev => data.models.some(m => m.id === prev) ? prev : (data.models.find(modelHasTools)?.id || data.models[0].id));
      }
    } catch {}
  }

  async function loadAssistants() {
    try {
      const res = await fetch(`${API}/api/assistants`);
      const data = await res.json();
      const rows = Array.isArray(data) ? data : [];
      setAssistants(rows);
      setAssistantId(prev => (prev && rows.some(a => a.id === prev)) ? prev : (rows[0]?.id || null));
      const chosen = rows.find(a => a.id === assistantId) || rows[0];
      if (chosen?.model) setModel(chosen.model);
    } catch {}
  }

  async function fetchConversations(cid = clientId) {
    const res = await fetch(`${API}/api/conversations${cid ? `?client=${encodeURIComponent(cid)}` : ''}`);
    if (res.status === 401) { const e = new Error('auth'); e.auth = true; throw e; }
    if (!res.ok) throw new Error('Falha ao listar conversas.');
    const data = await res.json();
    const rows = Array.isArray(data) ? data : []; // nunca deixa um objeto de erro quebrar o render
    setConversations(rows);
    loadAllConvs(); // mantém a lista global (todos os clientes) para a busca
    return rows;
  }

  // Todas as conversas, de qualquer cliente — usado pela busca da barra lateral
  async function loadAllConvs() {
    try { const d = await (await fetch(`${API}/api/conversations?all=1`)).json(); setAllConvs(Array.isArray(d) ? d : []); } catch {}
  }

  // Cria o registro da conversa só quando ele é realmente necessário (1ª
  // mensagem, anexo ou tarefa). Evita acumular conversas vazias no histórico.
  async function ensureConversation(cid = clientId) {
    if (current) return current;
    // Single-flight: se duas ações "primeiras" (ex.: anexar + enviar) dispararem
    // quase juntas, ambas veem current=null; sem isso, criariam 2 conversas.
    if (creatingConvRef.current) return creatingConvRef.current;
    const p = (async () => {
      try {
        const res = await fetch(`${API}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Nova conversa', model, clientId: cid || null }) });
        if (!res.ok) throw new Error();
        const c = await res.json();
        setConversations(prev => [c, ...prev]);
        setCurrent(c);
        setFiles([]);
        return c;
      } catch {
        showToast('Não foi possível criar a conversa. O servidor está no ar?');
        return null;
      }
    })();
    creatingConvRef.current = p;
    try { return await p; }
    finally { creatingConvRef.current = null; }
  }

  async function openConversation(id) {
    if (blockConversationChange()) return;
    setDeveloperSession(null);
    setLoadingConv(true);
    setMenuOpen(false);
    try {
      const res = await fetch(`${API}/api/conversations/${id}`);
      const data = await res.json();
      setCurrent(data.conversation);
      setMessages(data.messages || []);
      loadFiles(id);
    } catch {
      showToast('Não foi possível abrir a conversa.');
    } finally {
      setLoadingConv(false);
    }
  }

  async function deleteConversation(id, e) {
    e.stopPropagation();
    const confirmed = await askConfirm({
      title: 'Apagar conversa?',
      message: 'A conversa e todos os arquivos dela serão apagados. Essa ação não pode ser desfeita.',
      confirmLabel: 'Apagar conversa',
      destructive: true
    });
    if (!confirmed) return;
    try {
      const res = await fetch(`${API}/api/conversations/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível apagar a conversa.');
      }
      await fetchConversations();
      if (current?.id === id) startNewChat();
    } catch (err) {
      showToast(err.message || 'Não foi possível apagar a conversa.');
    }
  }

  async function loadFiles(id = current?.id) {
    if (!id) return;
    try {
      const res = await fetch(`${API}/api/conversations/${id}/files`);
      const d = await res.json();
      setFiles(Array.isArray(d) ? d : []);
    } catch {}
  }

  async function openFilesDrawer() {
    if (!current?.id) { showToast('Abra uma conversa para ver os arquivos dela.'); return; }
    await loadFiles(current.id);
    setFilesDrawerOpen(true);
  }

  // ---- Ditado por voz (Web Speech API) ----
  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showToast('Seu navegador não suporta ditado por voz. Use o Google Chrome ou o Microsoft Edge.'); return; }
    if (listening) { recognitionRef.current?.stop(); return; }
    const rec = new SR();
    rec.lang = 'pt-BR';
    rec.interimResults = true;
    rec.continuous = true;
    let base = input;
    rec.onresult = (e) => {
      let finalT = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalT += t; else interim += t;
      }
      if (finalT) base = (base ? base + ' ' : '') + finalT.trim();
      setInput((base + (interim ? ' ' + interim : '')).trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }

  async function deleteFile(f) {
    if (!current) return;
    const confirmed = await askConfirm({
      title: 'Excluir arquivo?',
      message: `"${f.name}" será removido desta conversa.`,
      confirmLabel: 'Excluir arquivo',
      destructive: true
    });
    if (!confirmed) return;
    try {
      const encoded = f.path.split('/').map(encodeURIComponent).join('/');
      await fetch(`${API}/api/conversations/${current.id}/files/${encoded}`, { method: 'DELETE' });
      await loadFiles();
    } catch {
      showToast('Não foi possível excluir o arquivo.');
    }
  }

  async function uploadSelectedFiles(selected, source = 'input') {
    const filesToUpload = [...(selected || [])].filter(Boolean);
    if (!filesToUpload.length) return;
    let conv = current;
    if (!conv) { conv = await ensureConversation(); if (!conv) return; }
    setUploadingFiles(true);
    try {
      const fd = new FormData();
      filesToUpload.forEach(f => fd.append('files', f));
      const res = await fetch(`${API}/api/conversations/${conv.id}/upload`, { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '');
      await loadFiles(conv.id);
      if (d.rejected?.length) {
        showToast(`🛡️ Antivírus: ${d.rejected.length} arquivo(s) recusado(s) por conter ameaça: ${d.rejected.map(r => r.name).join(', ')}`);
      } else if (source !== 'input') {
        showToast(`${filesToUpload.length} arquivo(s) anexado(s)${d.scanned ? ' e verificado(s) pelo antivírus ✓' : ''}.`, 'ok');
      }
      if (d.scanned && !d.rejected?.length) {
        setScanOk(true);
        setTimeout(() => setScanOk(false), 5000);
      }
    } catch (err) {
      showToast(err?.message || 'Falha no envio do arquivo. Verifique o tamanho (máx. 50 MB) e tente de novo.');
    } finally {
      setUploadingFiles(false);
    }
  }

  async function uploadFiles(e) {
    await uploadSelectedFiles(e.target.files, 'input');
    e.target.value = '';
  }

  function hasDraggedFiles(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
  }
  function onDragEnter(e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }
  function onDragOver(e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }
  async function onDrop(e) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    await uploadSelectedFiles(e.dataTransfer.files, 'drop');
  }
  async function onPasteFiles(e) {
    const pasted = Array.from(e.clipboardData?.files || []);
    if (!pasted.length) return;
    e.preventDefault();
    await uploadSelectedFiles(pasted, 'paste');
  }

  function pickAssistant(id) {
    setAssistantId(id);
    const a = assistants.find(x => x.id === id);
    if (a?.model) setModel(a.model);
  }

  // ---- Assistant Studio ----
  function openStudioNew() { setForm(emptyForm()); setStudioOpen(true); }
  function openStudioEdit(a) {
    setForm({ id: a.id, name: a.name, emoji: a.emoji || 'bot', color: a.color || '', model: a.model || model, system_prompt: a.system_prompt || '', template: '', tools: a.tools?.length ? a.tools : TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20, ...(a.personality || {}) } });
    setStudioOpen(true);
  }
  function applyTemplate(key) {
    const t = TEMPLATES.find(x => x.key === key);
    if (!t) { setForm(f => ({ ...f, template: '' })); return; }
    // Só herda o ícone do template se a pessoa ainda não escolheu um: 'bot' é
    // o padrão de emptyForm(), e '🤖' era o padrão antes da migração.
    const untouched = f => f.emoji === 'bot' || f.emoji === '🤖';
    setForm(f => ({ ...f, template: key, system_prompt: t.prompt, emoji: untouched(f) ? t.emoji : f.emoji, name: f.name || t.label }));
  }
  function toggleTool(name) {
    setForm(f => ({ ...f, tools: f.tools.includes(name) ? f.tools.filter(t => t !== name) : [...f.tools, name] }));
  }
  function setSlider(key, val) { setForm(f => ({ ...f, personality: { ...f.personality, [key]: Number(val) } })); }

  async function saveAssistant() {
    if (!form.name.trim() || !form.system_prompt.trim()) { showToast('Preencha o nome e as instruções do assistente.'); return; }
    try {
      const payload = { name: form.name, emoji: form.emoji, color: form.color || null, model: form.model || model, system_prompt: form.system_prompt, tools: form.tools, personality: form.personality };
      const url = form.id ? `${API}/api/assistants/${form.id}` : `${API}/api/assistants`;
      const res = await fetch(url, { method: form.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error();
      const saved = await res.json();
      await loadAssistants();
      if (saved?.id) pickAssistant(saved.id);
      setStudioOpen(false);
    } catch {
      showToast('Não foi possível salvar o assistente.');
    }
  }

  async function deleteAssistant() {
    if (!form.id) return;
    const confirmed = await askConfirm({
      title: 'Excluir assistente?',
      message: 'O assistente será removido. As conversas existentes continuarão preservadas.',
      confirmLabel: 'Excluir assistente',
      destructive: true
    });
    if (!confirmed) return;
    try {
      await fetch(`${API}/api/assistants/${form.id}`, { method: 'DELETE' });
      setStudioOpen(false);
      const res = await fetch(`${API}/api/assistants`);
      const rows = await res.json();
      setAssistants(rows);
      if (assistantId === form.id) pickAssistant(rows[0]?.id || null);
    } catch {
      showToast('Não foi possível excluir o assistente.');
    }
  }

  // ---- Analytics ----
  async function openAnalytics() {
    setAnalyticsOpen(true);
    setAnalytics(null);
    try { setAnalytics(await (await fetch(`${API}/api/analytics`)).json()); }
    catch { showToast('Não foi possível carregar as análises.'); }
  }

  // ---- Controle: pausar / continuar / parar ----
  async function control(action) {
    if (!current || !busyRef.current || controlPending) return;
    const conversationId = current.id;
    setControlPending(true);
    if (action === 'pause') setStatusText('Pausando...');
    if (action === 'resume') setStatusText('Retomando...');
    if (action === 'stop') setStatusText('Interrompendo...');
    try {
      const response = await fetch(`${API}/api/conversations/${conversationId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || 'Não foi possível controlar o processamento.');
      if (action === 'pause') setPaused(Boolean(result.paused));
      if (action === 'resume' || action === 'stop') setPaused(false);
    } catch (err) {
      setStatusText('');
      showToast(err?.message || 'Não foi possível controlar o processamento.');
    } finally {
      setControlPending(false);
    }
  }

  // Reenvia uma mensagem que falhou: remove o balão de erro (e o balão do
  // usuário) e dispara o envio de novo com o mesmo texto.
  async function retrySend(idx, text) {
    if (busy || !text) return;
    const userMessage = messages[idx - 1];
    const savedUserMessage = userMessage?.role === 'user'
      && userMessage.id
      && !String(userMessage.id).startsWith('local-');
    if (savedUserMessage && current?.id) {
      try {
        const res = await fetch(`${API}/api/conversations/${current.id}/truncate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: userMessage.id })
        });
        if (!res.ok) throw new Error();
      } catch {
        showToast('Não foi possível preparar a nova tentativa. A conversa foi preservada.');
        return;
      }
    }
    setMessages(prev => prev.slice(0, Math.max(0, idx - 1)));
    await loadFiles();
    await sendMessage(text);
  }

  // Recuperação após queda de conexão: a tarefa CONTINUA no servidor e o
  // resultado é salvo, então buscamos a resposta pronta recarregando a conversa
  // (em vez de mostrar "Conexão interrompida"). Roda em segundo plano; quando o
  // último item da conversa for a resposta do assistente já salva, exibe-a.
  async function recoverPendingReply(convId) {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 4000)); // verifica a cada 4s (até ~4 min)
      if (currentRef.current?.id !== convId) return; // usuário saiu desta conversa
      try {
        const res = await fetch(`${API}/api/conversations/${convId}`);
        if (!res.ok) continue;
        const data = await res.json();
        const msgs = data.messages || [];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant' && String(last.content || '').trim()) {
          if (currentRef.current?.id === convId) { setMessages(msgs); loadFiles(convId); }
          return;
        }
      } catch {}
    }
  }

  async function sendMessage(textArg) {
    const isRetry = typeof textArg === 'string';
    const typed = (isRetry ? textArg : input).trim();
    // "Zero atrito": se o usuário anexou algo (ex.: uma foto) e não escreveu
    // nada, usamos um pedido padrão para a IA ler/analisar o anexo sozinha.
    const text = typed || (!isRetry && uploads.length > 0
      ? 'Leia e analise o(s) arquivo(s)/foto que enviei e me responda com base no conteúdo.'
      : '');
    if (!text || busyRef.current) return;
    if (team && effectiveTeam.length === 0) { showToast('Selecione ao menos 1 assistente no painel da Equipe.'); return; }
    if (listening) recognitionRef.current?.stop();
    setChatBusy(true);
    let conv = current;
    if (!conv) { conv = await ensureConversation(); if (!conv) { setChatBusy(false); return; } }
    if (!isRetry) setInput('');
    const activeDeveloper = developerSession && (!developerSession.conversationId || developerSession.conversationId === conv.id) ? developerSession : null;
    if (activeDeveloper && !activeDeveloper.conversationId) setDeveloperSession({ ...activeDeveloper, conversationId: conv.id });
    setPaused(false);
    setStatusText('Pensando...');
    const assistantMsgId = `local-${Date.now()}`;
    // created_at aqui e' o horario local do envio; ao recarregar, o valor do
    // servidor (server.js) substitui. Sem isto, a mensagem recem-enviada nao
    // tem hora e o separador de data nao consegue agrupa-la.
    const sentAt = new Date().toISOString();
    setMessages(prev => [...prev, { role: 'user', content: text, created_at: sentAt }, { id: assistantMsgId, role: 'assistant', content: '', blocks: [], created_at: sentAt }]);
    let assistantMessageKey = assistantMsgId;
    const update = (fn) => {
      const key = assistantMessageKey;
      setMessages(prev => prev.map(m => m.id === key ? fn(m) : m));
    };

    const body = team
      ? {
          message: text,
          model,
          assistantId,
          webSearch,
          effort,
          orchestrate: true,
          orchestrateIds: effectiveTeam.map(a => a.id),
          ...(activeDeveloper ? { developer: { mode: activeDeveloper.mode, projectId: activeDeveloper.projectId, github: activeDeveloper.github || null, rules: activeDeveloper.rules } } : {})
        }
      : {
          message: text,
          model,
          assistantId,
          webSearch,
          effort,
          ...(activeDeveloper ? { developer: { mode: activeDeveloper.mode, projectId: activeDeveloper.projectId, github: activeDeveloper.github || null, rules: activeDeveloper.rules } } : {})
        };
    try {
      const res = await fetch(`${API}/api/conversations/${conv.id}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (res.status === 401) { setChatBusy(false); setStatusText(''); setNeedLogin(true); return; }
      if (!res.ok) {
        let msg = `O servidor respondeu com erro (${res.status}).`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
        update(m => ({ ...m, failed: true, retryText: text, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Erro:** ${msg}` }] }));
        showToast(msg);
        setChatBusy(false); setPaused(false); setStatusText('');
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('A resposta do servidor não pôde ser lida.');
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        if (done) buffer += decoder.decode();
        const parsed = takeSseEvents(buffer, { flush: done });
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.type === 'status') setStatusText(ev.content || '');
          if (ev.type === 'memory_context') update(m => ({ ...m, memory: ev.memory }));
          if (ev.type === 'delta') update(m => {
            const blocks = [...(m.blocks || [])];
            const last = blocks[blocks.length - 1];
            if (last && last.type === 'text') blocks[blocks.length - 1] = { ...last, content: last.content + ev.content };
            else blocks.push({ type: 'text', content: ev.content });
            return { ...m, blocks, content: (m.content || '') + ev.content };
          });
          if (ev.type === 'tool_start') { setStatusText(`Executando ${ev.name}...`); update(m => ({ ...m, blocks: [...(m.blocks || []), { type: 'tool', name: ev.name, preview: ev.preview, status: 'running', started: Date.now() }] })); }
          if (ev.type === 'tool_result') update(m => {
            const blocks = [...(m.blocks || [])];
            const status = toolResultFailed(ev.content) ? 'error' : 'done';
            for (let i = blocks.length - 1; i >= 0; i--) { if (blocks[i].type === 'tool' && blocks[i].status === 'running') { blocks[i] = { ...blocks[i], status, ended: Date.now(), result: ev.content }; break; } }
            return { ...m, blocks };
          });
          if (ev.type === 'files') update(m => ({ ...m, files: [...(m.files || []), ...ev.files] }));
          if (ev.type === 'file_checks') update(m => ({
            ...m,
            files: (m.files || []).map(file => ev.checks?.[file.path] ? { ...file, check: ev.checks[file.path] } : file)
          }));
          if (ev.type === 'saved') {
            const previousKey = assistantMessageKey;
            assistantMessageKey = ev.assistantMessageId;
            setMessages(prev => {
              const arr = [...prev];
              const ai = arr.findIndex(m => m.id === previousKey);
              if (ai > -1) { arr[ai] = { ...arr[ai], id: ev.assistantMessageId }; if (arr[ai - 1]?.role === 'user') arr[ai - 1] = { ...arr[ai - 1], id: ev.userMessageId }; }
              return arr;
            });
          }
          if (ev.type === 'execution_failed') {
            update(m => ({ ...m, failed: true, retryText: text }));
            if (ev.content) showToast(ev.content);
          }
          if (ev.type === 'error') update(m => ({ ...m, failed: true, retryText: text, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Erro:** ${ev.content}` }] }));
        }
        if (done) break;
      }
    } catch (err) {
      // A conexão SSE caiu (trocar de aba / minimizar no celular / rede
      // oscilando). A tarefa CONTINUA rodando no servidor e salva o resultado —
      // então, em vez de marcar como falha, deixamos um aviso calmo e buscamos
      // a resposta pronta em segundo plano (aparece aqui quando terminar).
      update(m => ({ ...m, retryText: text, blocks: [...(m.blocks || []), { type: 'text', content: '\n\n_A conexão caiu, mas a tarefa continua rodando no servidor. O resultado aparece aqui assim que terminar — se preferir, é só recarregar a conversa._' }] }));
      recoverPendingReply(conv.id);
    }
    // Fecha qualquer ferramenta que tenha ficado "rodando"
    update(m => ({ ...m, blocks: (m.blocks || []).map(b => b.type === 'tool' && b.status === 'running' ? { ...b, status: 'done', ended: Date.now() } : b) }));
    setChatBusy(false);
    setPaused(false);
    setStatusText('');
    await loadFiles(conv.id);
    try {
      const rows = await fetchConversations();
      const updated = rows.find(c => c.id === conv.id);
      if (updated) setCurrent(updated);
    } catch {}
  }

  const currentAssistant = assistants.find(a => a.id === assistantId);
  const uploads = files.filter(f => f.kind === 'upload');

  // Sessão expirada durante o uso: leva de volta ao login.
  if (needLogin) {
    return <div className="connError">
      <div className="connErrorCard">
        <div className="brand" style={{ marginBottom: 0 }}>Frederico <span>AI Studio</span></div>
        <p>Sua sessão expirou. Entre novamente para continuar.</p>
        <button className="primary" onClick={() => { window.location.href = '/'; }}>Ir para o login</button>
      </div>
    </div>;
  }

  // Tela de erro de conexão (backend fora do ar)
  if (connError) {
    return <div className="connError">
      <div className="connErrorCard">
        <h2>Não foi possível conectar ao servidor</h2>
        <p>Verifique se o aplicativo está ligado (Docker Desktop aberto e <code>iniciar.bat</code> executado) e tente novamente.</p>
        <button className="primary" onClick={init}><RefreshCw size={15}/> Tentar novamente</button>
      </div>
    </div>;
  }

  const activeWorkspace = WORKSPACES.find(item => item.id === workspace) || WORKSPACES[0];
  const ActiveWorkspaceIcon = WORKSPACE_ICON[activeWorkspace.id] || Sparkles;
  const activeClientName = clients.find(c => c.id === clientId)?.name || 'Geral';
  const workspaceWelcome = {
    studio: { title: 'Olá! Como posso ajudar você hoje?', description: 'Envie um arquivo, peça uma planilha, um documento, um código ou uma pesquisa.' },
    essential: { title: 'Vamos resolver isso.', description: 'Use um atalho ou escreva o que você precisa fazer.' },
    focus: { title: 'No que você quer se concentrar?', description: 'Uma conversa por vez, com o restante do app fora do caminho.' },
    developer: { title: 'Qual é a próxima mudança?', description: 'Planeje, construa ou revise um projeto com contexto e permissões claras.' }
  }[workspace] || { title: 'Olá! Como posso ajudar você hoje?', description: 'Envie um arquivo, peça uma planilha, um documento, um código ou uma pesquisa.' };
  const welcomeActions = workspace === 'developer' ? DEVELOPER_QUICK_ACTIONS : QUICK_ACTIONS;

  return <div className={`app workspace-${workspace} ${sideHidden ? 'sideHidden' : ''}`}>
    {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)}/>}
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Navegação do app">
      <div className="brandRow">
        <div className="brandLead">
          <span className="brandMark" aria-hidden="true">F</span>
          <div className="brand">Frederico <span>AI Studio</span></div>
        </div>
        <button className="sideCollapse" onClick={toggleSide} title="Esconder a barra lateral" aria-label="Esconder a barra lateral"><PanelLeft size={17}/></button>
      </div>
      <button className="new" onClick={startNewChat}><Plus size={16}/> Nova conversa</button>
      <div className="clientLabel">Cliente ou projeto</div>
      <ClientPicker clients={clients} clientId={clientId} onPick={switchClient} onAdd={addClient} onRemove={removeClient}/>
      <div className="convSearch">
        <Search size={15}/>
        <input value={convFilter} onChange={e => setConvFilter(e.target.value)} placeholder="Buscar conversas..."/>
        {convFilter && <button className="convSearchX" onClick={() => setConvFilter('')} aria-label="Limpar busca"><X size={13}/></button>}
      </div>
      <div className="sideScroll" ref={sideScrollRef}>
      <div className="sideSectionTitle">Conversas</div>
      <div className="convList">
        {(() => {
          const q = convFilter.trim().toLowerCase();
          // Sem busca: mostra as do cliente atual. Com busca: procura em TODAS
          // as conversas (qualquer cliente) — assim nada "some" por causa do escopo.
          const list = q ? allConvs.filter(c => (c.title || '').toLowerCase().includes(q)) : conversations;
          const otherCount = allConvs.length - conversations.length;
          if (list.length === 0) {
            if (q) return <p className="muted small">Nenhuma conversa encontrada para "{convFilter}".</p>;
            return <p className="muted small">Nenhuma conversa neste cliente ainda.{otherCount > 0 ? ` Há ${otherCount} em outros clientes — use a busca ou troque o cliente acima.` : ''}</p>;
          }
          return list.map(c => (
            <div key={c.id} className={`convItem ${current?.id === c.id ? 'active' : ''}`}>
              <button className="convOpen" onClick={() => openConversation(c.id)} title={c.title}>{c.title}</button>
              <button className="convDel" onClick={(e) => deleteConversation(c.id, e)} title="Apagar conversa" aria-label="Apagar conversa"><Trash2 size={15}/></button>
            </div>
          ));
        })()}
      </div>
      <nav className="sideBottom" aria-label="Recursos do app">
        <div className="navGroup navGroupProduction">
          <div className="navGroupTitle">Produção</div>
          <button className="studio toolsBtn" onClick={() => setToolsOpen(true)} title="Fluxos prontos: documentos, planilhas, OCR e dashboards"><Wrench size={16}/> Ferramentas</button>
          <button className="studio" onClick={() => setInboxOpen(true)} title="Acumule documentos por cliente e abra tudo numa conversa"><Inbox size={16}/> Caixa de entrada</button>
          <button className="studio" onClick={openTemplates}><BookMarked size={16}/> Templates</button>
        </div>
        <div className="navGroup navGroupDeveloper">
          <div className="navGroupTitle">Desenvolvimento</div>
          <button className="studio developerBtn" onClick={() => openDeveloper('plan')} title="Planejar, construir ou revisar um projeto"><Code2 size={16}/> Modo desenvolvedor</button>
        </div>
        <div className="navGroup navGroupAutomation">
          <div className="navGroupTitle">Automação</div>
          <button className="studio" onClick={() => { setTasksOpen(true); pollTasks(); }}><ListTodo size={16}/> Tarefas{tasksActive && <span className="badge">{tasks.filter(t => t.status === 'queued' || t.status === 'running').length}</span>}</button>
          <button className="studio" onClick={() => setRoutinesOpen(true)} title="Programe tarefas para rodarem sozinhas"><CalendarClock size={16}/> Rotinas</button>
        </div>
        <div className="navGroup navGroupKnowledge">
          <div className="navGroupTitle">Conhecimento</div>
          <button className="studio" onClick={() => setMemoryOpen(true)}><Brain size={16}/> Memória</button>
          {me?.pcFoldersEnabled && <button className="studio" onClick={() => setPcOpen(true)} title="Libere pastas do seu PC para o assistente procurar, ler e organizar arquivos"><FolderCog size={16}/> Pastas do PC</button>}
        </div>
        <div className="navGroup navGroupAdmin">
          <div className="navGroupTitle">Administração</div>
          <button className="studio" onClick={openStudioNew}><Bot size={16}/> Assistentes</button>
          <button className="studio" onClick={openAnalytics}><BarChart3 size={16}/> Análises</button>
          {me?.isAdmin && <button className="studio" onClick={() => window.open(`${API}/api/backup`, '_blank')} title="Baixa um arquivo com o banco e todos os workspaces (somente administrador)"><HardDriveDownload size={16}/> Backup</button>}
          <button className="studio" onClick={() => setProviderOpen(true)} title="Cadastre a sua própria chave de API"><KeyRound size={16}/> Provedor de IA</button>
          <button className="studio" onClick={() => setConnectorsOpen(true)} title="Conecte serviços externos, como o GitHub"><Cable size={16}/> Conectores</button>
          <button className="studio" onClick={() => setPrivacyOpen(true)} title="Exportar dados, apagar histórico ou excluir a conta (LGPD)"><ShieldCheck size={16}/> Privacidade e dados</button>
          <button className="studio" onClick={() => setThemeOpen(true)} title="Trocar a paleta e o espaço de trabalho"><Palette size={16}/> Aparência</button>
        </div>
      </nav>
      </div>
      <div className="sideFoot" title={user?.email || 'Sua conta'}>
        <span className="sideFootUser">{user?.name || user?.email || 'Minha conta'}</span>
        <button className="sideFootOut" title="Sair da conta"
          onClick={async () => { try { await signOut(); } catch {} window.location.href = '/'; }}>
          <LogOut size={14}/> Sair
        </button>
      </div>
    </aside>

    <main
      className={`chat ${dragActive ? 'dragActive' : ''}`}
      onPaste={onPasteFiles}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive && <div className="dropOverlay" aria-hidden="true"><Upload size={30}/><span>Solte os arquivos aqui</span></div>}
      <header className="topbar">
        <div className="topLeft">
          <button className="hamburger" onClick={() => setMenuOpen(o => !o)} aria-label="Abrir menu"><Menu size={19}/></button>
          <button className="sideOpen" onClick={toggleSide} title="Mostrar a barra lateral" aria-label="Mostrar a barra lateral"><PanelLeft size={18}/></button>
          <div className="titleblock">
            <span className="crumbClient" title={`Cliente: ${activeClientName}`}>{activeClientName}</span>
            <ChevronRight className="crumbSep" size={12} aria-hidden="true"/>
            <strong>{current?.title || 'Nova conversa'}</strong>
          </div>
          <span className={`workspaceTopLabel workspaceTopLabel-${workspace}`} title={`Espaço de trabalho: ${activeWorkspace.label}`}>
            <ActiveWorkspaceIcon size={14}/><span>{activeWorkspace.label}</span>
          </span>
          <ContextPicker
            models={allModels} model={model} onModel={setModel}
            assistants={assistants} assistantId={assistantId} onPickAssistant={pickAssistant}
            currentAssistant={currentAssistant} team={team} onTeam={setTeam}
            teamIds={teamIds} onToggleMember={toggleTeamMember} effectiveTeam={effectiveTeam}
            onEditAssistant={() => currentAssistant ? openStudioEdit(currentAssistant) : openStudioNew()}/>
        </div>
        <div className="pickers desktopPickers">
          <button className="gear" onClick={openFilesDrawer} title="Arquivos da conversa" aria-label="Arquivos da conversa" disabled={!current?.id}><FolderOpen size={16}/></button>
          <div className="mpicker">
            <button className="gear" onClick={() => setExportOpen(o => !o)} title="Exportar conversa" disabled={exporting}>{exporting ? <span className="spin sm"/> : <FileDown size={16}/>}</button>
            {exportOpen && <div className="mpPanel exportPanel">
              <button className="mpItem" onClick={() => exportConv('pdf')}><span className="mpItemName">Exportar como PDF</span></button>
              <button className="mpItem" onClick={() => exportConv('docx')}><span className="mpItemName">Exportar como Word (.docx)</span></button>
            </div>}
          </div>
        </div>
        <div className="mobileTopActions mpicker" ref={topActionsRef}>
          <button className="gear" onClick={() => setTopActionsOpen(o => !o)} title="Mais opções da conversa" aria-label="Mais opções da conversa"><MoreHorizontal size={19}/></button>
          {topActionsOpen && <div className="mobileTopPanel">
            {/* Assistente / Equipe / Modelo saíram daqui: agora vivem no
                ContextPicker, o mesmo controle no celular e no desktop. */}
            <div className="mobileTopSection">
              <div className="mobileTopLabel">Conversa</div>
              <div className="mobileTopButtonGrid single">
                <button onClick={() => { setTopActionsOpen(false); openFilesDrawer(); }} disabled={!current?.id}><FolderOpen size={15}/> Arquivos</button>
              </div>
            </div>
            <div className="mobileTopSection">
              <div className="mobileTopLabel">Exportar conversa</div>
              <div className="mobileTopButtonGrid">
                <button onClick={() => exportConv('pdf')} disabled={!current?.id || !messages.length || exporting}><FileDown size={15}/> PDF</button>
                <button onClick={() => exportConv('docx')} disabled={!current?.id || !messages.length || exporting}><FileText size={15}/> Word</button>
              </div>
            </div>
          </div>}
        </div>
      </header>
      {workspace === 'developer' && <section className="workspaceBar developerWorkspaceBar" aria-label="Atalhos de desenvolvimento">
        <div className="workspaceBarLead">
          <Code2 size={17}/>
          <div>
            <strong>Área de projeto</strong>
            <span>{developerSession ? 'Tarefa de desenvolvimento preparada para esta conversa.' : 'Planeje, construa ou revise sem perder o contexto do projeto.'}</span>
          </div>
        </div>
        <div className="workspaceBarActions">
          <button type="button" className="workspaceAction" onClick={() => openDeveloper('plan')}><ListTodo size={15}/> Planejar</button>
          <button type="button" className="workspaceAction primary" onClick={() => openDeveloper('build')}><Code2 size={15}/> Construir</button>
          <button type="button" className="workspaceAction" onClick={() => openDeveloper('review')}><Check size={15}/> Revisar</button>
          <button type="button" className="workspaceIconAction" onClick={() => setPcOpen(true)} title="Gerenciar projetos e pastas" aria-label="Gerenciar projetos e pastas"><FolderCog size={16}/></button>
        </div>
      </section>}
      {unprotected && !authWarnHidden && <div className="authWarn">
        <span>🔓 <b>Sem senha de acesso.</b> Use apenas na sua rede local — não exponha na internet sem definir <code>APP_PASSWORD</code>.</span>
        <button onClick={() => { setAuthWarnHidden(true); localStorage.setItem('fred_authwarn_hidden', '1'); }} aria-label="Dispensar aviso"><X size={14}/></button>
      </div>}
      <section className={`messages ${!loadingConv && messages.length === 0 && !busy ? 'empty' : ''}`}>
        {loadingConv && <div className="working"><span className="spin"/><span>Carregando conversa...</span></div>}
        {!loadingConv && messages.length === 0 && !busy && <div className="welcome">
          <h2>{workspaceWelcome.title}</h2>
          <p>{workspaceWelcome.description}</p>
          <div className="quickCards">
            {welcomeActions.map((q, i) => {
              const QuickActionIcon = QUICK_ACTION_ICON[q.icon] || Sparkles;
              return <button key={i} className="quickCard" onClick={() => handleWelcomeAction(q)}>
                <span className="qcIcon" aria-hidden="true"><QuickActionIcon size={20}/></span>
                <span className="qcText"><b>{q.label}</b><small>{q.desc}</small></span>
              </button>;
            })}
          </div>
        </div>}
        {messages.map((m, idx) => {
        const showDay = dayKey(m.created_at) && dayKey(m.created_at) !== dayKey(messages[idx - 1]?.created_at);
        return <React.Fragment key={m.id || idx}>
          {showDay && <div className="dayDivider" role="separator">
            <span>{dayLabel(m.created_at)}{msgTime(m.created_at) && ` · ${msgTime(m.created_at)}`}</span>
          </div>}
          <div className={`msg ${m.role}`}>
            {/* A tabela messages não guarda quem respondeu, então o cabeçalho
                mostra o assistente selecionado agora. Numa conversa em que o
                assistente foi trocado, as mensagens antigas exibem o atual. */}
            {m.role === 'assistant' && <div className="msgHead">
              <AssistantTile assistant={currentAssistant} index={Math.max(0, assistants.findIndex(a => a.id === assistantId))} size={22} icon={12}/>
              <b>{currentAssistant?.name || 'Assistente'}</b>
              {msgTime(m.created_at) && <span className="msgTime">{msgTime(m.created_at)}</span>}
            </div>}
            <div className="msgActions">
              {m.role === 'user' && !busy && <button onClick={() => editMessage(m, idx)} title="Editar e regravar a conversa a partir daqui" aria-label="Editar mensagem"><Pencil size={13}/></button>}
              {m.role === 'user' && <button onClick={() => saveAsTemplate(m)} title="Salvar como template reutilizável" aria-label="Salvar como template"><BookmarkPlus size={13}/></button>}
              <button onClick={() => copyMessage(m, idx)} title="Copiar a mensagem inteira" aria-label="Copiar mensagem">{copiedIdx === idx ? <Check size={13}/> : <Copy size={13}/>}</button>
            </div>
            {m.blocks
              ? m.blocks.map((b, i) => b.type === 'tool'
                ? <ToolStep key={i} step={b} nowTick={nowTick}/>
                : <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{b.content || ''}</ReactMarkdown>)
              : (m.role === 'user'
                ? <Collapsible text={m.content}>{t => <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{t}</ReactMarkdown>}</Collapsible>
                : <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{m.content || ''}</ReactMarkdown>)}
            {m.role === 'assistant' && m.failed && <button className="retryBtn" onClick={() => retrySend(idx, m.retryText)}><RefreshCw size={14}/> Reenviar</button>}
            {m.role === 'assistant' && <MemoryTrace memory={m.memory} onOpenMemory={() => setMemoryOpen(true)}/>}
            {m.files?.length > 0 && <div className="filecards">
              {m.files.map(f => {
                const url = conversationDownloadUrl(current?.id, f.path);
                const isImg = /\.(png|jpe?g|gif|webp)$/i.test(f.name);
                return isImg
                  ? <a className="imgcard" key={f.id || f.path} href={url} target="_blank" rel="noreferrer" title={`${f.name} — clique para abrir`}>
                      <img src={url} alt={f.name} loading="lazy"/>
                      <span>{f.name} · {Math.ceil((f.size || 0) / 1024)} KB</span>
                    </a>
                  : <a className="filecard" key={f.id || f.path} href={url} target="_blank" rel="noreferrer">
                      <span className="fcicon"><FileText size={20}/></span>
                      <span className="fcinfo"><b>{f.name}</b><small>{Math.ceil((f.size || 0) / 1024)} KB{f.check && <span className={f.check.ok ? 'okBadge' : 'warnBadge'}> · {f.check.ok ? `✓ verificado (${f.check.info})` : `⚠ ${f.check.info}`}</span>}</small></span>
                      <span className="fcdl"><Download size={16}/> Baixar</span>
                    </a>;
              })}
            </div>}
          </div>
        </React.Fragment>;
        })}
        {busy && <div className="working">
          {paused ? <span className="pausedDot"/> : <span className="spin"/>}
          <span>{paused ? 'Pausado' : (statusText || 'Processando...')}</span>
          <div className="workctl">
            {!paused
              ? <button onClick={() => control('pause')} title="Pausar a resposta" disabled={controlPending}><Pause size={14}/> Pausar</button>
              : <button onClick={() => control('resume')} title="Continuar" disabled={controlPending}><Play size={14}/> Continuar</button>}
            <button className="stopBtn" onClick={() => control('stop')} title="Parar o processamento" disabled={controlPending}><Square size={13}/> Parar</button>
          </div>
        </div>}
        <div ref={endRef}/>
      </section>
      <footer className="composerWrap">
        {developerSession && (!developerSession.conversationId || developerSession.conversationId === current?.id) && <div className="devSessionBar">
          <Code2 size={15}/><span>Modo desenvolvedor</span><b>{{ plan: 'Planejar', build: 'Construir', review: 'Revisar' }[developerSession.mode] || 'Ativo'}</b>
          {developerSession.github?.repo && <span className="muted" title={`Repositório GitHub${developerSession.github.branch ? ` · branch ${developerSession.github.branch}` : ''}`}>· {developerSession.github.repo}{developerSession.github.branch ? ` (${developerSession.github.branch})` : ''}</span>}
          <button onClick={() => setDeveloperSession(null)} title="Sair do modo desenvolvedor" aria-label="Sair do modo desenvolvedor"><X size={14}/></button>
        </div>}
        {uploads.length > 0 && <div className="attachChips">
          {uploads.map(f => <span className="attachChip" key={f.id}>
            <FileText size={13}/><span className="chipname" title={f.name}>{f.name}</span>
            <button onClick={() => deleteFile(f)} aria-label="Remover anexo"><X size={12}/></button>
          </span>)}
        </div>}
        {uploadingFiles && <div className="attachStatus"><span className="spin sm"/><span>Anexando arquivo...</span></div>}
        {!uploadingFiles && scanOk && <div className="attachStatus scanOk"><ShieldCheck size={13}/><span>Arquivos verificados pelo antivírus</span></div>}
        <div className="composerChips" ref={cmpChipsRef}>
          <button type="button" className={`cmpChip ${webSearch ? 'on' : ''}`} aria-pressed={webSearch}
            onClick={() => setWebSearch(w => !w)}
            title="Deixa a IA pesquisar na internet ao responder">
            <Globe size={12}/><span>Pesquisa na internet{webSearch ? ' · ativa' : ''}</span>
          </button>
          <div className="cmpChipMenu">
            <button type="button" className={`cmpChip ${composerMenuOpen ? 'open' : ''}`} aria-expanded={composerMenuOpen}
              onClick={() => setComposerMenuOpen(o => !o)}
              title={EFFORT_DESC}>
              <Gauge size={12}/><span>Esforço: {EFFORTS.find(e => e.id === effort)?.label}</span>
            </button>
            {composerMenuOpen && <div className="cmpMenuPanel effortPanel">
              <div className="cmpDesc">{EFFORT_DESC}</div>
              {EFFORTS.map(e => (
                <button key={e.id} className="cmpItem" onClick={() => { setEffort(e.id); setComposerMenuOpen(false); }}>
                  <span className="effortLabel">{e.label}{e.badge && <span className="effortBadge">{e.badge}</span>}</span>
                  {effort === e.id && <Check size={15} className="cmpChk"/>}
                </button>
              ))}
            </div>}
          </div>
          <button type="button" className={`cmpChip ${listening ? 'on' : ''}`} aria-pressed={listening}
            onClick={toggleMic}
            title={listening ? 'Parar o ditado' : 'Ditar a mensagem por voz'}>
            <Mic size={12}/><span>{listening ? 'Ouvindo...' : 'Ditar por voz'}</span>
          </button>
          <button type="button" className="cmpChip" disabled={!input.trim() || busy}
            onClick={sendAsTask}
            title="Envia a mensagem como tarefa e libera o chat enquanto ela roda">
            <Hourglass size={12}/><span>Executar em segundo plano</span>
          </button>
        </div>
        <div className="composer">
          <button className="attachBtn" onClick={() => fileInputRef.current?.click()} title="Anexar arquivo" aria-label="Anexar arquivo"><Paperclip size={19}/></button>
          <input ref={fileInputRef} type="file" multiple onChange={uploadFiles} style={{ display: 'none' }}/>
          <button className="attachBtn" onClick={() => setCameraOpen(true)} title="Tirar foto com a câmera" aria-label="Tirar foto com a câmera"><Camera size={19}/></button>
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} placeholder={listening ? 'Ouvindo... fale agora' : (webSearch ? 'Pesquisa na internet ativada — pergunte algo atual...' : 'Peça para analisar arquivos, gerar Word, Excel, PDF...')} />
          <button className="sendBtn" onClick={sendMessage} disabled={busy} aria-label="Enviar"><ArrowUp size={18}/></button>
        </div>
        <div className="composerHints">
          <span>Enter envia · Shift+Enter quebra linha</span>
          <span className="composerLgpd" title="O conteúdo da conversa é enviado ao provedor de IA para gerar a resposta. Evite incluir dados sensíveis, sigilosos ou desnecessários — saiba mais na Política de Privacidade.">
            As mensagens vão ao provedor de IA — evite dados sensíveis ou sigilosos · <a href="/privacidade" target="_blank" rel="noreferrer">Privacidade</a>
          </span>
        </div>
      </footer>
    </main>

    {filesDrawerOpen && <Drawer title="Arquivos da conversa" icon={<FolderOpen size={18}/>} onClose={() => setFilesDrawerOpen(false)} className="filesDrawer">
      <p className="muted drawerIntro">Anexos e arquivos gerados nesta conversa ficam reunidos aqui para você encontrar, abrir ou baixar sem procurar no histórico.</p>
      {!files.length && <div className="drawerEmpty"><FolderOpen size={28}/><b>Nenhum arquivo nesta conversa</b><span>Anexe um documento ou peça para a IA gerar um arquivo.</span></div>}
      <div className="assetList">
        {files.map(f => {
          const url = conversationDownloadUrl(current?.id, f.path);
          return <div className="assetRow" key={f.id || f.path}>
            <a className="assetOpen" href={url} target="_blank" rel="noreferrer">
              <span className="assetIcon"><FileText size={18}/></span>
              <span className="assetInfo"><b>{f.name}</b><small>{f.kind === 'upload' ? 'Anexado' : 'Gerado pela IA'} · {Math.ceil((f.size || 0) / 1024)} KB</small></span>
              <Download size={16}/>
            </a>
            <button className="assetDelete" onClick={() => deleteFile(f)} title="Excluir arquivo" aria-label={`Excluir ${f.name}`}><Trash2 size={15}/></button>
          </div>;
        })}
      </div>
    </Drawer>}

    {toast && <div className={`toast ${toast.kind || 'err'}`} role="alert">{toast.text}<button onClick={() => setToast(null)} aria-label="Fechar aviso"><X size={14}/></button></div>}

    {studioOpen && <Modal title={form.id ? 'Editar assistente' : 'Novo assistente'} icon={<Bot size={18}/>} onClose={() => setStudioOpen(false)}>
      <div className="frow">
        <label className="grow">Nome
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex.: Assistente de escrita"/>
        </label>
      </div>

      <div className="field">
        <span className="fieldLabel">Ícone do assistente</span>
        {!isAssistantIcon(form.emoji) && <p className="fieldHint">
          Este assistente usa o emoji <b>{form.emoji}</b>, de antes dos ícones. Escolher um ícone abaixo substitui o emoji.
        </p>}
        <div className="iconPicker">
          {ASSISTANT_ICONS.map(name => {
            const Icon = ASSISTANT_ICON[name];
            const sel = form.emoji === name;
            return <button key={name} type="button" aria-label={name} aria-pressed={sel}
              className={`iconOpt ${sel ? 'sel' : ''}`}
              style={sel ? { color: form.color || ASSISTANT_COLORS[0] } : undefined}
              onClick={() => setForm(f => ({ ...f, emoji: name }))}><Icon size={17}/></button>;
          })}
        </div>
      </div>

      <div className="field">
        <span className="fieldLabel">Cor</span>
        <div className="colorPicker">
          {ASSISTANT_COLORS.map(c => (
            <button key={c} type="button" aria-label={`Cor ${c}`} aria-pressed={form.color === c}
              className={`colorOpt ${form.color === c ? 'sel' : ''}`}
              style={{ '--swatch': c }}
              onClick={() => setForm(f => ({ ...f, color: f.color === c ? '' : c }))}/>
          ))}
          <span className="colorHint">{form.color ? 'Clique de novo para voltar ao padrão' : 'Padrão (pela ordem na lista)'}</span>
        </div>
      </div>

      <label>Modelo de IA padrão
        <select value={form.model || model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))}>
          {allModels.filter(modelHasTools).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>

      <label>Começar de um template
        <select value={form.template || ''} onChange={e => applyTemplate(e.target.value)}>
          <option value="">— escolher um modelo pronto —</option>
          {/* <option> não renderiza SVG — só o rótulo. O ícone do template
              aparece na grade acima assim que ele é aplicado. */}
          {TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </label>

      <label>Instruções do assistente (system prompt)
        <textarea rows={7} value={form.system_prompt} onChange={e => setForm(f => ({ ...f, system_prompt: e.target.value }))} placeholder="Descreva em linguagem natural o papel, a especialidade e o comportamento esperado do assistente."/>
      </label>

      <div className="field">
        <span className="fieldLabel">Ferramentas disponíveis</span>
        <div className="tools">
          {TOOL_INFO.map(t => (
            <label key={t.name} className="chk">
              <input type="checkbox" checked={form.tools.includes(t.name)} onChange={() => toggleTool(t.name)}/> {t.label}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="fieldLabel">Personalidade</span>
        <Slider label="Formalidade" hintA="Informal" hintB="Formal" value={form.personality.form} onChange={v => setSlider('form', v)}/>
        <Slider label="Detalhamento" hintA="Conciso" hintB="Detalhado" value={form.personality.det} onChange={v => setSlider('det', v)}/>
        <Slider label="Criatividade" hintA="Preciso" hintB="Criativo" value={form.personality.criat} onChange={v => setSlider('criat', v)}/>
      </div>

      <div className="modalActions">
        {form.id && <button className="danger" onClick={deleteAssistant}>Excluir</button>}
        <div className="spacer"/>
        <button onClick={() => setStudioOpen(false)}>Cancelar</button>
        <button className="primary" onClick={saveAssistant}>Salvar assistente</button>
      </div>
    </Modal>}

    {memoryOpen && <MemoryPanel assistants={assistants} clients={clients} clientId={clientId} showToast={showToast} askConfirm={askConfirm} askPrompt={askPrompt} onClose={() => setMemoryOpen(false)}/>}
    {pcOpen && <PcFoldersPanel showToast={showToast} askConfirm={askConfirm} onClose={() => setPcOpen(false)}/>}
    {toolsOpen && <ToolsPanel onPick={pickTool} onClose={() => setToolsOpen(false)}/>}
    {developerOpen && <DeveloperPanel initialMode={developerStartMode} onStart={startDeveloperTask} onManageFolders={() => { setDeveloperOpen(false); setPcOpen(true); }} onOpenConnectors={() => { setDeveloperOpen(false); setConnectorsOpen(true); }} onClose={() => setDeveloperOpen(false)}/>}
    {routinesOpen && <RoutinesPanel assistants={assistants} clients={clients} showToast={showToast} askConfirm={askConfirm} onClose={() => setRoutinesOpen(false)}/>}
    {inboxOpen && <InboxPanel clients={clients} clientId={clientId} showToast={showToast} askConfirm={askConfirm} onOpenConversation={(id) => { fetchConversations(); openConversation(id); }} onClose={() => setInboxOpen(false)}/>}
    {providerOpen && <ProviderPanel showToast={showToast} onClose={() => setProviderOpen(false)}/>}
    {connectorsOpen && <ConnectorsPanel showToast={showToast} onClose={() => setConnectorsOpen(false)}/>}
    {privacyOpen && <PrivacyPanel user={user} showToast={showToast} askConfirm={askConfirm} askPrompt={askPrompt}
      onHistoryCleared={() => { startNewChat(); fetchConversations(); }} onClose={() => setPrivacyOpen(false)}/>}
    {needsConsent && <ConsentGate onAccepted={() => setNeedsConsent(false)}/>}
    {cameraOpen && <CameraCapture
      onClose={() => setCameraOpen(false)}
      onCapture={async (file) => { setCameraOpen(false); await uploadSelectedFiles([file], 'camera'); }}
    />}
    {themeOpen && <Modal title="Aparência e espaço de trabalho" icon={<Palette size={18}/>} onClose={() => setThemeOpen(false)}>
      <p className="muted appearanceIntro">Escolha como o app se organiza e, depois, a paleta que deixa a leitura mais confortável. As duas escolhas ficam salvas neste computador.</p>
      <section className="appearanceSection" aria-labelledby="workspace-title">
        <div className="appearanceSectionHead">
          <div><strong id="workspace-title">Espaço de trabalho</strong><span>Altera a ordem, a densidade e os atalhos da interface.</span></div>
        </div>
        <div className="workspaceGrid">
          {WORKSPACES.map(item => {
            const Icon = WORKSPACE_ICON[item.id] || Sparkles;
            return <button key={item.id} type="button" className={`workspaceCard ${workspace === item.id ? 'sel' : ''}`} aria-pressed={workspace === item.id} onClick={() => changeWorkspace(item.id)}>
              <span className={`workspacePreview workspacePreview-${item.id}`} aria-hidden="true"><i/><i/><i/></span>
              <span className="workspaceCardCopy"><b><Icon size={15}/>{item.label}{workspace === item.id && <Check size={14}/>}</b><small>{item.description}</small></span>
              <span className="workspaceHint">{item.hint}</span>
            </button>;
          })}
        </div>
      </section>
      <section className="appearanceSection paletteSection" aria-labelledby="palette-title">
        <div className="appearanceSectionHead">
          <div><strong id="palette-title">Paleta</strong><span>Altera apenas as cores do espaço de trabalho escolhido.</span></div>
        </div>
        <div className="themeGrid">
          {THEMES.map(t => (
            <button key={t.id} className={`themeCard ${theme === t.id ? 'sel' : ''}`} onClick={() => setTheme(t.id)}>
              <span className="themeSwatch">{t.swatch.map((c, i) => <i key={i} style={{ background: c }}/>)}</span>
              <span className="themeName">{t.label}{theme === t.id && <Check size={14}/>}</span>
            </button>
          ))}
        </div>
      </section>
    </Modal>}

    {analyticsOpen && <Drawer title="Análises de uso" icon={<BarChart3 size={18}/>} onClose={() => setAnalyticsOpen(false)} className="analyticsDrawer">
      {!analytics && <div className="working"><span className="spin"/><span>Carregando...</span></div>}
      {analytics && <>
        <div className="statRow">
          <div className="stat"><b>{analytics.totals?.messages || 0}</b><span>mensagens</span></div>
          <div className="stat"><b>{(analytics.totals?.tokens || 0).toLocaleString('pt-BR')}</b><span>tokens no total</span></div>
          <div className="stat"><b>{(analytics.totals?.prompt_tokens || 0).toLocaleString('pt-BR')}</b><span>tokens de entrada</span></div>
        </div>
        <div className="field">
          <span className="fieldLabel">Por assistente</span>
          <table className="atable"><thead><tr><th>Assistente</th><th>Msgs</th><th>Tokens</th></tr></thead>
            <tbody>{(analytics.byAssistant || []).map((r, i) => <tr key={i}><td><span className="asstCell"><AssistantGlyph value={r.emoji} size={13}/>{r.name}</span></td><td>{r.messages}</td><td>{(r.tokens || 0).toLocaleString('pt-BR')}</td></tr>)}
            {(!analytics.byAssistant || !analytics.byAssistant.length) && <tr><td colSpan={3} className="muted">Sem dados ainda.</td></tr>}</tbody>
          </table>
        </div>
        <div className="field">
          <span className="fieldLabel">Por modelo de IA</span>
          <table className="atable"><thead><tr><th>Modelo</th><th>Msgs</th><th>Tokens</th></tr></thead>
            <tbody>{(analytics.byModel || []).map((r, i) => <tr key={i}><td>{r.model}</td><td>{r.messages}</td><td>{(r.tokens || 0).toLocaleString('pt-BR')}</td></tr>)}
            {(!analytics.byModel || !analytics.byModel.length) && <tr><td colSpan={3} className="muted">Sem dados ainda.</td></tr>}</tbody>
          </table>
        </div>
        <div className="field">
          <span className="fieldLabel">Por conversa (15 maiores)</span>
          <table className="atable"><thead><tr><th>Conversa</th><th>Msgs</th><th>Tokens</th></tr></thead>
            <tbody>{(analytics.byConversation || []).map((r, i) => <tr key={i}><td>{r.title}</td><td>{r.messages}</td><td>{(r.tokens || 0).toLocaleString('pt-BR')}</td></tr>)}
            {(!analytics.byConversation || !analytics.byConversation.length) && <tr><td colSpan={3} className="muted">Sem dados ainda.</td></tr>}</tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Tokens são a medida de consumo dos modelos. O custo em R$/US$ depende do preço de cada modelo no OpenRouter.</p>
      </>}
    </Drawer>}

    {tplOpen && <Modal title="Templates de pedido" icon={<BookMarked size={18}/>} onClose={() => setTplOpen(false)}>
      <p className="muted" style={{ margin: 0 }}>Clique num template para usá-lo na conversa. Para criar o seu, passe o mouse numa mensagem sua no chat e clique no ícone de marcador.</p>
      <div className="memList">
        {templates.length === 0 && <p className="muted">Nenhum template ainda.</p>}
        {templates.map(t => (
          <button className="tplItem" key={t.id} onClick={() => useTemplate(t)} title="Usar este template">
            <span className="tplName">{t.name}</span>
            <span className="tplPreview">{t.content.slice(0, 110)}{t.content.length > 110 ? '…' : ''}</span>
            <span className="memDel tplDel" onClick={(e) => deleteTemplate(t.id, e)} role="button" aria-label="Excluir template"><X size={15}/></span>
          </button>
        ))}
      </div>
    </Modal>}

    {tasksOpen && <Drawer title="Fila de tarefas" icon={<ListTodo size={18}/>} onClose={() => setTasksOpen(false)} className="tasksDrawer">
      <p className="muted" style={{ margin: 0 }}>Tarefas rodam em segundo plano — você pode trocar de conversa ou fechar o app; a fila continua no servidor. Para criar uma, escreva o pedido e clique na ⏳ ao lado do enviar.</p>
      <div className="memList">
        {tasks.length === 0 && <p className="muted">Nenhuma tarefa ainda.</p>}
        {tasks.map(t => (
          <div className="taskItem" key={t.id}>
            <div className="taskTop">
              <span className={`taskStatus ${t.status}`}>
                {t.status === 'queued' && '⏳ Na fila'}
                {t.status === 'running' && <><span className="spin sm"/> Executando</>}
                {t.status === 'done' && '✅ Concluída'}
                {t.status === 'error' && '⚠️ Falhou'}
                {t.status === 'canceled' && '✖ Cancelada'}
              </span>
              <span className="taskConv" title={t.conv_title}>{t.conv_title || 'Conversa'}</span>
            </div>
            <div className="taskPrompt">{t.prompt.slice(0, 120)}{t.prompt.length > 120 ? '…' : ''}</div>
            {t.status === 'running' && t.progress_text && <div className="taskProg">{t.progress_text}</div>}
            {t.status === 'error' && t.error && <div className="taskProg err">{t.error.slice(0, 140)}</div>}
            <div className="taskActions">
              {(t.status === 'queued' || t.status === 'running') && <button onClick={() => cancelTask(t.id)}>Cancelar</button>}
              {t.status === 'done' && <button className="primary" onClick={() => { setTasksOpen(false); openConversation(t.conversation_id); }}>Abrir conversa</button>}
            </div>
          </div>
        ))}
      </div>
    </Drawer>}
    {appDialog}
  </div>;
}
