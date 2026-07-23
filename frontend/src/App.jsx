import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Download, FileText, FileSpreadsheet, FilePenLine, Plus, ArrowUp, Upload, Trash2, Bot, Brain, X, BarChart3, Pause, Play, Square, Mic, Globe, Menu, RefreshCw, Sparkles, Copy, Check, Pencil, BookMarked, BookmarkPlus, FileDown, HardDriveDownload, Hourglass, ListTodo, FolderCog, Search, PanelLeft, Wrench, CalendarClock, Inbox, Palette, Gauge, SlidersHorizontal, Paperclip, MoreHorizontal, FolderOpen, Code2, ChevronRight, ShieldCheck, LogOut, KeyRound, Camera, Cable, MessageCircleQuestion, Bug, PanelRight, Lock, Unlock } from 'lucide-react';
import { API, TOOL_INFO, TEMPLATES, QUICK_ACTIONS, THEMES, WORKSPACES, EFFORTS, EFFORT_DESC, ASSISTANT_ICONS, ASSISTANT_COLORS, isAssistantIcon, DEV_WORK_MODES, MAX_ASSISTANT_PROFILE_CHARS } from './constants.js';
import { signOut } from './authClient.js';
import { Slider, Modal, Drawer, Collapsible, useAppDialog, ModelPicker } from './components.jsx';
import { ExecutionSession } from './components/ExecutionSession.jsx';
import { DevProjectRail } from './components/DevProjectRail.jsx';
import { DevActivityRail } from './components/DevActivityRail.jsx';
import { MemoryPanel } from './MemoryPanel.jsx';
import { PcFoldersPanel } from './PcFoldersPanel.jsx';
import { ToolsPanel } from './ToolsPanel.jsx';
import { DeveloperPanel } from './DeveloperPanel.jsx';
import { RoutinesPanel } from './RoutinesPanel.jsx';
import { InboxPanel } from './InboxPanel.jsx';
import { ProviderPanel } from './ProviderPanel.jsx';
import { FreeOnboarding, FreeModeBadge, FreeModeDrawer, FreeLimitModal, fetchFreeStatus } from './FreeMode.jsx';
import { KeyWizard } from './KeyWizard.jsx';
import { FreeAdminPanel } from './FreeAdminPanel.jsx';
import { ConnectorsPanel } from './ConnectorsPanel.jsx';
import { PrivacyPanel, ConsentGate } from './PrivacyPanel.jsx';
import { CameraCapture } from './CameraCapture.jsx';
import { Companion } from './Companion.jsx';
import { useCompanion } from './hooks/useCompanion.js';
import { ContextPicker, AssistantGlyph, AssistantTile, ASSISTANT_ICON, modelHasTools } from './components/ContextPicker.jsx';
import { MultiModelPicker } from './components/MultiModelPicker.jsx';
import { MultiModelBoard } from './components/MultiModelBoard.jsx';
import { ClientPicker } from './components/ClientPicker.jsx';
import { MemoryTrace } from './components/MemoryTrace.jsx';
import { useAssistants } from './hooks/useAssistants.js';
import { useConversations } from './hooks/useConversations.js';
import { useSpeech } from './hooks/useSpeech.js';
import { useFileUploads } from './hooks/useFileUploads.js';
import { useChat } from './hooks/useChat.js';
import { useTasks } from './hooks/useTasks.js';
import { useDevProjects, projectContextText } from './hooks/useDevProjects.js';

const QUICK_ACTION_ICON = {
  document: FileText,
  spreadsheet: FileSpreadsheet,
  writing: FilePenLine,
  search: Search,
  ask: MessageCircleQuestion,
  plan: ListTodo,
  build: Code2,
  fix: Bug,
  review: Check,
  auto: Bot,
  folder: FolderCog
};

const WORKSPACE_ICON = {
  studio: Bot,
  essential: SlidersHorizontal,
  focus: Sparkles,
  developer: Code2
};

// ---- Data e hora das mensagens ----
const parseDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
const msgTime = (v) => parseDate(v)?.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) || '';
const dayKey = (v) => parseDate(v)?.toDateString() || '';
const conversationDownloadUrl = (conversationId, filePath) => {
  const encodedId = encodeURIComponent(String(conversationId || ''));
  const encodedPath = String(filePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${API}/api/conversations/${encodedId}/download/${encodedPath}`;
};
// Markdown é caro (o rehype-highlight recolore todo bloco de código a cada
// render). Enquanto a IA responde, o app re-renderiza a cada token e a cada
// segundo do relógio — sem memo, TODA mensagem antiga era re-parseada junto,
// e é isso que travava/engasgava a tela. Com React.memo por conteúdo, só o
// texto que realmente mudou é reprocessado.
const MessageText = React.memo(function MessageText({ text }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{text || ''}</ReactMarkdown>;
});

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

const DEVELOPER_QUICK_ACTIONS = [
  { icon: 'plan', label: 'Planejar uma mudança', desc: 'Entenda o projeto antes de editar', mode: 'plan' },
  { icon: 'build', label: 'Implementar', desc: 'Aplique alterações no projeto escolhido', mode: 'build' },
  { icon: 'fix', label: 'Corrigir um erro', desc: 'Investigue a causa raiz e valide a solução', mode: 'fix' },
  { icon: 'review', label: 'Revisar o projeto', desc: 'Arquitetura, segurança e qualidade', mode: 'review' }
];

export default function App({ user } = {}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [allModels, setAllModels] = useState([]);
  const [model, setModel] = useState('');
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [pcOpen, setPcOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [developerSession, setDeveloperSession] = useState(null);
  const [developerStartMode, setDeveloperStartMode] = useState('plan');
  const devProjects = useDevProjects();
  const [devLeftCollapsed, setDevLeftCollapsed] = useState(() => localStorage.getItem('fred_dev_left') === '1');
  const [devRightCollapsed, setDevRightCollapsed] = useState(() => localStorage.getItem('fred_dev_right') === '1');
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  // ---- Modo gratuito ----
  const [freeStatus, setFreeStatus] = useState(null);        // GET /api/free-tier/status
  const [freeOnbOpen, setFreeOnbOpen] = useState(false);     // escolha do 1º acesso
  const [freeDrawerOpen, setFreeDrawerOpen] = useState(false);
  const [freeAdminOpen, setFreeAdminOpen] = useState(false);
  const [keyWizardOpen, setKeyWizardOpen] = useState(false); // assistente de chave própria
  const [freeLimitInfo, setFreeLimitInfo] = useState(null);  // tela de limite atingido
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  // LGPD: true quando o usuário ainda não aceitou a versão vigente dos
  // Termos/Política (login social, conta antiga ou termos atualizados) —
  // nesse caso um modal bloqueante pede o aceite antes de liberar o app.
  const [needsConsent, setNeedsConsent] = useState(false);
  const [team, setTeam] = useState(false);
  const [teamIds, setTeamIds] = useState(() => { try { return JSON.parse(localStorage.getItem('fred_team') || 'null'); } catch { return null; } });
  // Multimodelo: { enabled, config } — 2+ modelos de IA na mesma mensagem
  const [multiModel, setMultiModel] = useState(() => { try { return JSON.parse(localStorage.getItem('fred_multimodel') || 'null'); } catch { return null; } });
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('fred_theme') || 'dark');
  const [workspace, setWorkspace] = useState(() => {
    const saved = localStorage.getItem('fred_workspace');
    return WORKSPACES.some(item => item.id === saved) ? saved : 'studio';
  });
  const [themeOpen, setThemeOpen] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [effort, setEffort] = useState(() => { const s = localStorage.getItem('fred_effort'); return EFFORTS.some(e => e.id === s) ? s : 'medio'; });
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const cmpChipsRef = useRef(null);
  const fileInputRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sideHidden, setSideHidden] = useState(() => localStorage.getItem('fred_workspace') === 'focus' || localStorage.getItem('fred_side_hidden') === '1');
  const [convFilter, setConvFilter] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [me, setMe] = useState(null); // { email, isAdmin, pcFoldersEnabled }
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
  const endRef = useRef(null);
  const messagesRef = useRef(null);
  const lastScrollConv = useRef(null);
  const inputRef = useRef(null);
  const topActionsRef = useRef(null);
  const sideScrollRef = useRef(null);
  const toastTimer = useRef(null);
  const copyTimer = useRef(null);
  const { askConfirm, askPrompt, dialog: appDialog } = useAppDialog();

  // ---- Hooks extraídos (App.jsx modularizado): cada um recebe as dependências
  // por parâmetro e devolve { estado, ações }. showToast, blockConversationChange
  // e startNewChat são declarações de função (içadas), por isso podem ser
  // passadas aqui mesmo sendo definidas mais abaixo — só rodam em eventos. ----
  const {
    assistants, assistantId, studioOpen, setStudioOpen, form, setForm,
    loadAssistants, pickAssistant, openStudioNew, openStudioEdit,
    applyTemplate, toggleTool, setSlider, saveAssistant, deleteAssistant
  } = useAssistants({ model, setModel, showToast, askConfirm });
  // Ponte entre os hooks: openConversation (useConversations) precisa disparar a
  // reconexão ao stream ao vivo, que vive no useChat — criado DEPOIS. O ref quebra
  // essa ordem sem acoplar os hooks.
  const followActiveRef = useRef(null);
  const {
    conversations, allConvs, current, setCurrent, currentRef, files, setFiles, loadingConv,
    fetchConversations, loadAllConvs, ensureConversation, openConversation, deleteConversation, loadFiles
  } = useConversations({ clientId, model, setModel, showToast, blockConversationChange, askConfirm,
    startNewChat, setMessages, setDeveloperSession, setMenuOpen, followActiveRef, setNeedLogin });
  const { listening, recognitionRef, toggleMic } = useSpeech({ input, setInput, showToast });
  const {
    dragActive, uploadingFiles, scanOk, deleteFile, uploadSelectedFiles, uploadFiles, waitForUploads,
    onDragEnter, onDragOver, onDragLeave, onDrop, onPasteFiles
  } = useFileUploads({ current, ensureConversation, loadFiles, showToast, askConfirm });
  // Membros ativos da equipe (null = todos)
  const effectiveTeam = assistants.filter(a => !teamIds || teamIds.includes(a.id));
  const uploads = files.filter(f => f.kind === 'upload');
  // Multimodelo só vale com 2+ modelos selecionados; senão o fluxo é o normal
  const effectiveMulti = multiModel?.enabled && (multiModel.config?.models?.length || 0) >= 2 ? multiModel.config : null;
  const {
    busy, busyRef, paused, statusText, controlPending, nowTick, runs, anyBusy, sendMessage, retrySend, resumeRun, control, cancelMultiSlot
  } = useChat({
    input, setInput, messages, setMessages, uploads, team, effectiveTeam,
    listening, recognitionRef, current, currentRef, setCurrent,
    ensureConversation, fetchConversations, loadFiles, waitForUploads,
    developerSession, setDeveloperSession, followActiveRef,
    model, assistantId, webSearch, effort, multiModel: effectiveMulti, setNeedLogin, showToast,
    // Modo gratuito: status ao vivo (restante/renovação) e tela de limite
    onFreeEvent: ({ type, _seq, ...status }) => setFreeStatus(prev => ({ ...(prev || {}), ...status })),
    onFreeLimit: (info) => setFreeLimitInfo(info)
  });
  const { tasks, tasksOpen, setTasksOpen, tasksActive, pollTasks, sendAsTask, cancelTask } = useTasks({
    current, busyRef, openConversation, ensureConversation,
    input, setInput, listening, recognitionRef,
    model, assistantId, webSearch, showToast, waitForUploads
  });
  // Frederico Companion — camada de experiência (personagem flutuante). Recebe
  // as tarefas para a detecção proativa (tarefas que falham viram alertas).
  // Conversa de desenvolvimento ativa (para o monitoramento de Git do Companion):
  // a sessão do modo dev, ou a conversa aberta quando o workspace é o "developer".
  const devConversationId = developerSession?.conversationId || (workspace === 'developer' ? current?.id : null) || null;
  const companion = useCompanion({ tasks, devConversationId, showToast });

  function changeMultiModel(next) {
    setMultiModel(next);
    try { localStorage.setItem('fred_multimodel', JSON.stringify(next)); } catch {}
    // Multimodelo e Modo Equipe são mutuamente exclusivos na prática (o backend
    // dá prioridade ao multimodelo) — desligar a equipe evita confusão.
    if (next?.enabled) setTeam(false);
  }

  // Ações dos cartões multimodelo
  function continueWithModel(card) {
    setModel(card.id);
    changeMultiModel({ ...(multiModel || {}), enabled: false });
    showToast(`A conversa seguirá apenas com ${card.name}.`, 'ok');
  }
  function askReviewOfModel(card) {
    setInput(`Revise criticamente a resposta de ${card.name} (função: ${card.roleLabel}) acima: aponte erros, omissões e riscos, e produza uma versão final melhorada.`);
    setTimeout(() => inputRef.current?.focus(), 60);
  }
  function combineAnswers() {
    setInput('Combine as melhores partes das respostas dos modelos acima em UMA resposta final, resolvendo as divergências e descartando o que estiver errado.');
    setTimeout(() => inputRef.current?.focus(), 60);
  }

  function toggleTeamMember(id) {
    const cur = teamIds || assistants.map(a => a.id);
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    setTeamIds(next);
    localStorage.setItem('fred_team', JSON.stringify(next));
  }
  function blockConversationChange() {
    // MULTICONVERSA: trocar de conversa/cliente ou abrir uma nova NÃO
    // interrompe mais nada — a resposta continua no servidor, a conversa mostra
    // o indicador girando na barra lateral e, ao reabri-la, o andamento
    // reconecta ao vivo. A trava antiga ("aguarde terminar") saiu de cena.
    return false;
  }
  // Enquanto houver execução em andamento (aqui ou em outra aba/dispositivo),
  // atualiza a lista periodicamente para o indicador da barra lateral acender
  // e apagar sozinho.
  const sidebarActivity = anyBusy || conversations.some(c => c.active);
  useEffect(() => {
    if (!sidebarActivity) return;
    // clientId nas deps: sem ele, o intervalo guardava o fetchConversations do
    // render em que sidebarActivity virou true — preso ao cliente ANTIGO. Ao
    // trocar de cliente com uma execução em andamento, o poll recarregava a lista
    // do cliente anterior por cima da atual a cada 10 s. Re-subscrevendo quando
    // clientId muda, a closure passa a apontar para o cliente selecionado.
    const t = setInterval(() => { fetchConversations().catch(() => {}); }, 10000);
    return () => clearInterval(t);
  }, [sidebarActivity, clientId]);
  useEffect(() => { localStorage.setItem('fred_effort', effort); }, [effort]);
  useEffect(() => {
    // O painel de esforço e o de permissões vivem dentro da linha de chips,
    // então basta uma checagem: clicou fora dela, fecha os dois.
    function onDoc(e) {
      if (!cmpChipsRef.current?.contains(e.target)) { setComposerMenuOpen(false); setPermissionsOpen(false); }
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
  useEffect(() => {
    // Ao ABRIR/TROCAR de conversa, sempre desce até a última mensagem. Durante o
    // STREAMING (mesma conversa), só acompanha se o usuário já está perto do fim
    // — antes rolava a cada token (o array `messages` é trocado por delta),
    // sequestrando a rolagem de quem subia para reler algo durante a resposta.
    const convChanged = lastScrollConv.current !== (current?.id || null);
    lastScrollConv.current = current?.id || null;
    const el = messagesRef.current;
    if (!convChanged && el && el.scrollHeight - el.scrollTop - el.clientHeight > 120) return;
    endRef.current?.scrollIntoView({ behavior: convChanged ? 'auto' : 'smooth' });
  }, [messages, current?.id]);
  // Fecha o painel da equipe ao clicar fora
  useEffect(() => {
    function onDoc(e) { if (topActionsRef.current && !topActionsRef.current.contains(e.target)) setTopActionsOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function showToast(text, kind = 'err') {
    clearTimeout(toastTimer.current);
    setToast({ text, kind });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
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
      refreshFreeStatus();
    } catch (err) {
      if (err?.auth) setNeedLogin(true);
      else setConnError(true);
    }
  }

  // ---- Modo gratuito: status + onboarding do primeiro acesso ----
  // Recarrega o status (modelo, restante, fila) e decide se mostra a escolha
  // "Começar gratuitamente x chave própria" — só quando o usuário ainda não
  // tem NENHUM caminho para conversar (sem chave própria, sem chave do
  // servidor e sem adesão ao gratuito).
  async function refreshFreeStatus() {
    const status = await fetchFreeStatus();
    setFreeStatus(status);
    if (status?.configured && status.enabled && !status.optedIn && !status.hasAnyKey) {
      setFreeOnbOpen(true);
    }
    return status;
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

  function openDeveloper(mode) {
    // Sem modo explícito (ex.: botão da barra lateral), herda o modo salvo do
    // projeto ativo para não sobrescrever a preferência do usuário.
    setDeveloperStartMode(mode || devProjects.active?.mode || 'plan');
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
    currentRef.current = null;
    setMessages([]);
    setFiles([]);
    setInput('');
    setDeveloperSession(null);
    setMenuOpen(false);
    setFilesDrawerOpen(false);
    setTopActionsOpen(false);
    return true;
  }

  function startDeveloperTask({ devProjectId, mode, binding, brief }) {
    const project = devProjects.projects.find(p => p.id === devProjectId) || devProjects.active || null;
    const developerAssistant = assistants.find(assistant => /programa|codigo|codex|desenvolv/i.test(`${assistant.name || ''} ${assistant.system_prompt || ''}`)) || assistants[0];
    if (!startNewChat()) return;
    setTeam(false);
    setWebSearch(false);
    if (developerAssistant) pickAssistant(developerAssistant.id);
    // O vínculo do projeto vira o par (pasta do PC) OU (repositório GitHub) que
    // o backend espera. As regras + memória do projeto viajam pelo canal `rules`.
    const projectId = binding?.type === 'folder' ? (binding.folderId || null) : null;
    const github = binding?.type === 'github' && binding.repo ? { repo: binding.repo, branch: binding.branch || '' } : null;
    setDeveloperSession({ mode, projectId, github, rules: projectContextText(project), devProjectId: project?.id || null, conversationId: null });
    setInput(brief);
    setDeveloperOpen(false);
    setWorkspace('developer'); // revela o ambiente de desenvolvimento (colunas do IDE)
    setTimeout(() => inputRef.current?.focus(), 60);
    showToast('Tarefa de desenvolvimento pronta para enviar.', 'ok');
  }

  // Quando a sessão de desenvolvedor se vincula a uma conversa (1º envio),
  // registra a conversa no projeto para o histórico.
  useEffect(() => {
    if (developerSession?.conversationId && developerSession?.devProjectId) {
      devProjects.linkConversation(developerSession.devProjectId, developerSession.conversationId);
    }
  }, [developerSession?.conversationId, developerSession?.devProjectId]);

  // Colapso das colunas do ambiente de desenvolvimento (guardado entre sessões).
  function toggleDevLeft() { setDevLeftCollapsed(v => { localStorage.setItem('fred_dev_left', v ? '0' : '1'); return !v; }); }
  function toggleDevRight() { setDevRightCollapsed(v => { localStorage.setItem('fred_dev_right', v ? '0' : '1'); return !v; }); }

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
      const models = Array.isArray(data.models) ? data.models : [];
      setAllModels(models);
      setModel(prev => models.some(m => m.id === prev) ? prev : (models.find(modelHasTools)?.id || models[0]?.id || ''));
    } catch {}
  }

  async function openFilesDrawer() {
    if (!current?.id) { showToast('Abra uma conversa para ver os arquivos dela.'); return; }
    await loadFiles(current.id);
    setFilesDrawerOpen(true);
  }

  // ---- Analytics ----
  async function openAnalytics() {
    setAnalyticsOpen(true);
    setAnalytics(null);
    try { setAnalytics(await (await fetch(`${API}/api/analytics`)).json()); }
    catch { showToast('Não foi possível carregar as análises.'); }
  }

  const currentAssistant = assistants.find(a => a.id === assistantId);

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

  // Tarefas recentes do projeto ativo (Modo Desenvolvedor): resolve os ids
  // salvos em conversationIds para título real via allConvs — nada inventado,
  // só não mostra a tarefa se a conversa correspondente não existir mais.
  const recentDevTasks = (devProjects.active?.conversationIds || [])
    .map(id => { const c = allConvs.find(x => x.id === id); return c ? { id, title: c.title || 'Conversa' } : null; })
    .filter(Boolean)
    .slice(0, 8);

  // Pill de status do cabeçalho do Modo Desenvolvedor — só estados que dá para
  // provar com sinais reais (sem inventar um pipeline de 5 etapas que o
  // backend não expõe): aguardando / trabalhando / interrompido / erro / concluído.
  const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
  const devStagePill = busy
    ? { label: paused ? 'Pausado' : (statusText || 'Trabalhando...'), tone: 'live' }
    : lastAssistantMsg?.failed
      ? { label: 'Erro', tone: 'error' }
      : lastAssistantMsg?.resumable
        ? { label: 'Interrompido — pode continuar', tone: 'warn' }
        : messages.length > 0
          ? { label: 'Concluído', tone: 'done' }
          : { label: 'Aguardando instrução', tone: 'idle' };

  // Permissões reais desta tarefa (não um toggle fictício): modo ativo (ou o do
  // projeto, se ainda não há sessão preparada) e o vínculo de pasta/repositório.
  const permMode = DEV_WORK_MODES.find(m => m.id === (developerSession?.mode || devProjects.active?.mode)) || null;
  const permBinding = developerSession?.github
    ? { type: 'github', repo: developerSession.github.repo, branch: developerSession.github.branch }
    : devProjects.active?.binding;
  const permProjectLabel = permBinding?.type === 'github'
    ? `GitHub · ${permBinding.repo}${permBinding.branch ? ` (${permBinding.branch})` : ''}`
    : permBinding?.type === 'folder'
      ? 'Pasta do computador vinculada'
      : 'Sem vínculo — workspace temporário da conversa';

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
              {(runs[c.id] ? runs[c.id].busy : c.active) && <span className="spin sm convSpin" title="Esta conversa está processando agora" aria-label="Conversa processando"/>}
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
          <button className="studio developerBtn" onClick={() => openDeveloper()} title="Perguntar, planejar, implementar, corrigir ou revisar um projeto"><Code2 size={16}/> Modo desenvolvedor</button>
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
          {me?.isAdmin && freeStatus?.configured && <button className="studio" onClick={() => setFreeAdminOpen(true)} title="Usuários, consumo, bloqueios e limites do modo gratuito (somente administrador)"><Gauge size={16}/> Modo gratuito</button>}
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

    {workspace === 'developer' && <DevProjectRail
      collapsed={devLeftCollapsed}
      onToggle={toggleDevLeft}
      projects={devProjects.projects}
      active={devProjects.active}
      onSelectProject={devProjects.setActiveId}
      onNewTask={() => openDeveloper(devProjects.active?.mode || 'plan')}
      onManageFolders={() => setPcOpen(true)}
      files={files}
      onRefreshFiles={() => current?.id && loadFiles(current.id)}
      filesLoading={false}
      downloadUrl={(path) => conversationDownloadUrl(current?.id, path)}
      conversationId={current?.id}
      recentTasks={recentDevTasks}
      onOpenTask={openConversation}
    />}

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
          <MultiModelPicker models={allModels} value={multiModel} onChange={changeMultiModel} showToast={showToast}/>
          <FreeModeBadge status={freeStatus} onClick={() => { setFreeDrawerOpen(true); refreshFreeStatus(); }}/>
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
            <strong>{devProjects.active?.name || 'Ambiente de desenvolvimento'}</strong>
            <span>{developerSession
              ? `Tarefa preparada · ${DEV_WORK_MODES.find(m => m.id === developerSession.mode)?.label || 'Modo dev'}`
              : (devProjects.active ? 'Escolha um modo e descreva a missão para começar.' : 'Crie um projeto para trabalhar com contexto, memória e permissões próprias.')}</span>
          </div>
        </div>
        <div className="workspaceBarActions">
          <span className={`devStagePill ${devStagePill.tone}`}><span className="devStagePillDot"/>{devStagePill.label}</span>
          <button type="button" className="workspaceAction" onClick={() => openDeveloper('plan')}><ListTodo size={15}/> Planejar</button>
          <button type="button" className="workspaceAction primary" onClick={() => openDeveloper('build')}><Code2 size={15}/> Implementar</button>
          <button type="button" className="workspaceAction" onClick={() => openDeveloper('fix')}><Bug size={15}/> Corrigir</button>
          <button type="button" className="workspaceAction" onClick={() => openDeveloper('review')}><Check size={15}/> Revisar</button>
          {devRightCollapsed && <button type="button" className="workspaceIconAction" onClick={toggleDevRight} title="Mostrar atividades e memória" aria-label="Mostrar atividades e memória"><PanelRight size={16}/></button>}
        </div>
      </section>}
      {unprotected && !authWarnHidden && <div className="authWarn">
        <span>🔓 <b>Sem senha de acesso.</b> Use apenas na sua rede local — não exponha na internet sem definir <code>APP_PASSWORD</code>.</span>
        <button onClick={() => { setAuthWarnHidden(true); localStorage.setItem('fred_authwarn_hidden', '1'); }} aria-label="Dispensar aviso"><X size={14}/></button>
      </div>}
      <section ref={messagesRef} className={`messages ${!loadingConv && messages.length === 0 && !busy ? 'empty' : ''}`}>
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
        return <React.Fragment key={m._key || m.id || idx}>
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
            {/* Execução multimodelo: um cartão por modelo (status, resposta,
                tokens, custo) + ações por cartão. No modo Comparação o texto
                salvo é a própria junção das respostas — o quadro basta. */}
            {m.role === 'assistant' && m.multi && <MultiModelBoard
              multi={m.multi}
              live={Boolean(m.multi.live) || (busy && idx === messages.length - 1)}
              onCancelSlot={busy ? cancelMultiSlot : null}
              onContinueWith={continueWithModel}
              onAskReview={askReviewOfModel}
              onCombine={combineAnswers}
              downloadUrl={(path) => conversationDownloadUrl(current?.id, path)}/>}
            {/* Com o quadro multimodelo presente, o texto salvo (concatenação das
                respostas ou a síntese do coordenador) é redundante com o board —
                que já mostra tudo, inclusive a "Conclusão". Só NÃO suprimimos
                quando há execução real de ferramentas (pipeline do Modo
                Desenvolvedor), pois aí o texto é o entregável de verdade. */}
            {m.role === 'assistant' && m.multi && !(m.blocks || []).some(b => b.type === 'tool')
              ? null
              : m.blocks
              ? (() => {
                  // Todas as chamadas de ferramenta da resposta são agrupadas numa
                  // única "sessão de execução" (o Ambiente de Trabalho da IA), em vez
                  // de virarem dezenas de cartões soltos. O texto continua no lugar.
                  const toolSteps = m.blocks.filter(b => b.type === 'tool');
                  const firstToolIdx = m.blocks.findIndex(b => b.type === 'tool');
                  const sessionLive = (busy && idx === messages.length - 1) || toolSteps.some(s => s.status === 'running');
                  return m.blocks.map((b, i) => {
                    if (b.type === 'tool') {
                      return i === firstToolIdx
                        ? <ExecutionSession key="exec" steps={toolSteps} live={sessionLive} conversationId={current?.id}/>
                        : null;
                    }
                    return <MessageText key={i} text={b.content}/>;
                  });
                })()
              : (m.role === 'user'
                ? <Collapsible text={m.content}>{t => <MessageText text={t}/>}</Collapsible>
                : <MessageText text={m.content}/>)}
            {m.role === 'assistant' && m.resumable && !busy && <button className="retryBtn resumeBtn" onClick={() => resumeRun(current?.id)} title="Retoma a tarefa exatamente de onde parou, sem refazer o que já foi feito"><Play size={14}/> Continuar de onde parei</button>}
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
          <Code2 size={15}/><span>Modo desenvolvedor</span><b>{DEV_WORK_MODES.find(m => m.id === developerSession.mode)?.label || 'Ativo'}</b>
          {developerSession.github?.repo && <span className="muted" title={`Repositório GitHub${developerSession.github.branch ? ` · branch ${developerSession.github.branch}` : ''}`}>· {developerSession.github.repo}{developerSession.github.branch ? ` (${developerSession.github.branch})` : ''}</span>}
          <button onClick={() => setDeveloperSession(null)} title="Sair do modo desenvolvedor" aria-label="Sair do modo desenvolvedor"><X size={14}/></button>
        </div>}
        {uploads.length > 0 && <div className="attachChips">
          {uploads.map(f => <span className={`attachChip ${f.available === false ? 'missing' : ''}`} key={f.id} title={f.available === false ? 'Este arquivo não está mais disponível no servidor. Remova-o e anexe novamente.' : f.name}>
            <FileText size={13}/><span className="chipname">{f.name}{f.available === false ? ' · indisponível' : ''}</span>
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
          <button type="button" className="cmpChip" disabled={!input.trim() || busy || uploadingFiles}
            onClick={sendAsTask}
            title="Envia a mensagem como tarefa e libera o chat enquanto ela roda">
            <Hourglass size={12}/><span>Executar em segundo plano</span>
          </button>
          {workspace === 'developer' && <div className="cmpChipMenu">
            <button type="button" className={`cmpChip ${permissionsOpen ? 'open' : ''}`} aria-expanded={permissionsOpen}
              onClick={() => setPermissionsOpen(o => !o)}
              title="O que a IA pode fazer nesta tarefa">
              <ShieldCheck size={12}/><span>Permissões</span>
            </button>
            {permissionsOpen && <div className="cmpMenuPanel permissionsPanel">
              <div className="cmpDesc">O que a IA pode fazer nesta tarefa, com o modo e o projeto escolhidos agora.</div>
              <div className="permRow">
                <b>{permMode?.label || 'Nenhum modo escolhido'}</b>
                {permMode && <span className={permMode.write ? 'write' : 'read'}>{permMode.write ? <Unlock size={12}/> : <Lock size={12}/>}{permMode.write ? 'Pode editar e executar' : 'Somente leitura'}</span>}
              </div>
              <div className="permRow"><span>{permProjectLabel}</span></div>
            </div>}
          </div>}
        </div>
        <div className="composer">
          <button className="attachBtn" onClick={() => fileInputRef.current?.click()} title="Anexar arquivo" aria-label="Anexar arquivo"><Paperclip size={19}/></button>
          <input ref={fileInputRef} type="file" multiple onChange={uploadFiles} style={{ display: 'none' }}/>
          <button className="attachBtn" onClick={() => setCameraOpen(true)} title="Tirar foto com a câmera" aria-label="Tirar foto com a câmera"><Camera size={19}/></button>
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!uploadingFiles) sendMessage(); } }} placeholder={listening ? 'Ouvindo... fale agora' : (webSearch ? 'Pesquisa na internet ativada — pergunte algo atual...' : 'Peça para analisar arquivos, gerar Word, Excel, PDF...')} />
          <button className="sendBtn" onClick={sendMessage} disabled={busy || uploadingFiles} aria-label={uploadingFiles ? 'Aguardando anexos' : 'Enviar'}><ArrowUp size={18}/></button>
        </div>
        <div className="composerHints">
          <span>Enter envia · Shift+Enter quebra linha</span>
          <span className="composerLgpd" title="O conteúdo da conversa é enviado ao provedor de IA para gerar a resposta. Evite incluir dados sensíveis, sigilosos ou desnecessários — saiba mais na Política de Privacidade.">
            As mensagens vão ao provedor de IA — evite dados sensíveis ou sigilosos · <a href="/privacidade" target="_blank" rel="noreferrer">Privacidade</a>
          </span>
        </div>
      </footer>
    </main>

    {workspace === 'developer' && <DevActivityRail
      collapsed={devRightCollapsed}
      onToggle={toggleDevRight}
      busy={busy}
      statusText={statusText}
      messages={messages}
      project={devProjects.active}
      onUpdateMemory={(key, value) => devProjects.activeId && devProjects.updateProject(devProjects.activeId, p => ({ ...p, memory: { ...p.memory, [key]: value } }))}
      downloadUrl={(path) => conversationDownloadUrl(current?.id, path)}
    />}

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

      <div className="field">
        <span className="fieldLabel">Modelo de IA padrão</span>
        {/* Seletor completo (busca, filtros, capacidades, classificação, preço)
            — o mesmo da área de modelos, em vez de um <select> só com nomes. */}
        <ModelPicker models={allModels.filter(modelHasTools)} value={form.model || model} onChange={id => setForm(f => ({ ...f, model: id }))}/>
      </div>

      <label>Começar de um template
        <select value={form.template || ''} onChange={e => applyTemplate(e.target.value)}>
          <option value="">— escolher um modelo pronto —</option>
          {/* <option> não renderiza SVG — só o rótulo. O ícone do template
              aparece na grade acima assim que ele é aplicado. */}
          {TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </label>

      <label>Perfil e instruções do assistente
        <textarea rows={7} maxLength={MAX_ASSISTANT_PROFILE_CHARS} value={form.system_prompt} onChange={e => setForm(f => ({ ...f, system_prompt: e.target.value }))} placeholder="Descreva o papel, a especialidade, o estilo e o método do assistente."/>
        <span className="fieldHint">Este perfil não libera ferramentas, rede ou ações externas. {form.system_prompt.length.toLocaleString('pt-BR')}/{MAX_ASSISTANT_PROFILE_CHARS.toLocaleString('pt-BR')}</span>
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
    {developerOpen && <DeveloperPanel devProjects={devProjects} team={team} initialMode={developerStartMode} onStart={startDeveloperTask} onManageFolders={() => { setDeveloperOpen(false); setPcOpen(true); }} onOpenConnectors={() => { setDeveloperOpen(false); setConnectorsOpen(true); }} onClose={() => setDeveloperOpen(false)}/>}
    {routinesOpen && <RoutinesPanel assistants={assistants} clients={clients} showToast={showToast} askConfirm={askConfirm} onClose={() => setRoutinesOpen(false)}/>}
    {inboxOpen && <InboxPanel clients={clients} clientId={clientId} showToast={showToast} askConfirm={askConfirm} onOpenConversation={(id) => { fetchConversations(); openConversation(id); }} onClose={() => setInboxOpen(false)}/>}
    {providerOpen && <ProviderPanel showToast={showToast} freeStatus={freeStatus}
      onOpenWizard={() => { setProviderOpen(false); setKeyWizardOpen(true); }}
      onFreeChange={refreshFreeStatus}
      onProvidersChange={loadModels}
      onClose={() => { setProviderOpen(false); refreshFreeStatus(); loadModels(); }}
    />}
    {freeOnbOpen && <FreeOnboarding status={freeStatus} showToast={showToast}
      onStarted={() => { setFreeOnbOpen(false); refreshFreeStatus(); loadModels(); }}
      onOpenWizard={() => { setFreeOnbOpen(false); setKeyWizardOpen(true); }}
      onClose={() => setFreeOnbOpen(false)}/>}
    {freeDrawerOpen && <FreeModeDrawer status={freeStatus} onRefresh={refreshFreeStatus}
      onOpenWizard={() => { setFreeDrawerOpen(false); setKeyWizardOpen(true); }}
      onClose={() => setFreeDrawerOpen(false)}/>}
    {keyWizardOpen && <KeyWizard showToast={showToast}
      onDone={() => { refreshFreeStatus(); loadModels(); }}
      onClose={() => setKeyWizardOpen(false)}/>}
    {freeLimitInfo && <FreeLimitModal info={freeLimitInfo}
      onRetry={() => { const t = freeLimitInfo?.retryText; setFreeLimitInfo(null); if (t) sendMessage(t); }}
      onOpenWizard={() => { setFreeLimitInfo(null); setKeyWizardOpen(true); }}
      onClose={() => setFreeLimitInfo(null)}/>}
    {freeAdminOpen && <FreeAdminPanel showToast={showToast} askConfirm={askConfirm} askPrompt={askPrompt} onClose={() => setFreeAdminOpen(false)}/>}
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
          <div className="stat"><b>{(analytics.totals?.completion_tokens || 0).toLocaleString('pt-BR')}</b><span>tokens de saída</span></div>
          <div className="stat"><b>{Number(analytics.totals?.estimatedCost || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' })}</b><span>custo estimado*</span></div>
          <div className="stat"><b>{analytics.totals?.freeMessages || 0} / {analytics.totals?.paidMessages || 0}</b><span>usos grátis / pagos</span></div>
        </div>
        <div className="field">
          <span className="fieldLabel">Por provedor</span>
          <table className="atable"><thead><tr><th>Provedor</th><th>Msgs</th><th>Entrada</th><th>Saída</th><th>Estimativa</th></tr></thead>
            <tbody>{(analytics.byProvider || []).map((r, i) => <tr key={i}><td>{r.name}</td><td>{r.messages}</td><td>{(r.prompt_tokens || 0).toLocaleString('pt-BR')}</td><td>{(r.completion_tokens || 0).toLocaleString('pt-BR')}</td><td>{r.pricedMessages ? Number(r.estimatedCost || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }) : 'Não informado'}</td></tr>)}
            {(!analytics.byProvider || !analytics.byProvider.length) && <tr><td colSpan={5} className="muted">Sem dados ainda.</td></tr>}</tbody>
          </table>
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
          <table className="atable"><thead><tr><th>Modelo</th><th>Provedor</th><th>Msgs</th><th>Tokens</th><th>Estimativa</th></tr></thead>
            <tbody>{(analytics.byModel || []).map((r, i) => <tr key={i}><td>{r.model}</td><td>{r.providerName}</td><td>{r.messages}</td><td>{(r.tokens || 0).toLocaleString('pt-BR')}</td><td>{r.pricedMessages ? Number(r.estimatedCost || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }) : 'Não informado'}</td></tr>)}
            {(!analytics.byModel || !analytics.byModel.length) && <tr><td colSpan={5} className="muted">Sem dados ainda.</td></tr>}</tbody>
          </table>
        </div>
        <div className="field">
          <span className="fieldLabel">Por conversa (15 maiores)</span>
          <table className="atable"><thead><tr><th>Conversa</th><th>Msgs</th><th>Tokens</th><th>Estimativa</th></tr></thead>
            <tbody>{(analytics.byConversation || []).map((r, i) => <tr key={i}><td>{r.title}</td><td>{r.messages}</td><td>{(r.tokens || 0).toLocaleString('pt-BR')}</td><td>{r.pricedMessages ? Number(r.estimatedCost || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }) : 'Não informado'}</td></tr>)}
            {(!analytics.byConversation || !analytics.byConversation.length) && <tr><td colSpan={4} className="muted">Sem dados ainda.</td></tr>}</tbody>
          </table>
        </div>
        <div className="field">
          <span className="fieldLabel">Consumo mensal (12 meses)</span>
          <table className="atable"><thead><tr><th>Mês</th><th>Msgs</th><th>Entrada</th><th>Saída</th><th>Estimativa</th></tr></thead>
            <tbody>{(analytics.byMonth || []).map((r, i) => <tr key={i}><td>{r.name}</td><td>{r.messages}</td><td>{(r.prompt_tokens || 0).toLocaleString('pt-BR')}</td><td>{(r.completion_tokens || 0).toLocaleString('pt-BR')}</td><td>{r.pricedMessages ? Number(r.estimatedCost || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }) : 'Não informado'}</td></tr>)}
            {(!analytics.byMonth || !analytics.byMonth.length) && <tr><td colSpan={5} className="muted">Sem dados ainda.</td></tr>}</tbody>
          </table>
        </div>
        <div className="field">
          <span className="fieldLabel">Consumo diário (31 dias com uso)</span>
          <table className="atable"><thead><tr><th>Dia</th><th>Msgs</th><th>Tokens</th><th>Estimativa</th></tr></thead>
            <tbody>{(analytics.byDay || []).map((r, i) => <tr key={i}><td>{r.name}</td><td>{r.messages}</td><td>{(r.tokens || 0).toLocaleString('pt-BR')}</td><td>{r.pricedMessages ? Number(r.estimatedCost || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }) : 'Não informado'}</td></tr>)}
            {(!analytics.byDay || !analytics.byDay.length) && <tr><td colSpan={4} className="muted">Sem dados ainda.</td></tr>}</tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>* A estimativa interna usa os preços publicados no catálogo atual do respectivo provedor. Ela não é uma fatura nem um saldo oficial. Consulte o cartão do provedor para o saldo oficial quando a API o disponibilizar.</p>
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
    <Companion
      companion={companion}
      busy={busy}
      statusText={statusText}
      listening={listening}
      model={model}
      allModels={allModels}
      assistants={assistants}
      assistantId={assistantId}
      onSend={(text) => sendMessage(text)}
      onSetModel={setModel}
      onNewChat={startNewChat}
      onOpenDeveloper={() => setDeveloperOpen(true)}
      onOpenAssistants={openStudioNew}
      showToast={showToast}
    />
  </div>;
}
