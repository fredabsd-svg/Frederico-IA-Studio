import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Download, FileText, Plus, Send, Upload, Moon, Sun, Trash2, Settings, Bot, Brain, X, BarChart3, Users, Pause, Play, Square, Mic, Globe, Menu, RefreshCw, Sparkles, Copy, Check, Pencil, BookMarked, BookmarkPlus, FileDown, HardDriveDownload, Hourglass, ListTodo, FolderCog } from 'lucide-react';
import { API, FALLBACK_MODELS, TOOL_INFO, TEMPLATES, SUGGESTIONS, emptyForm } from './constants.js';
import { ToolStep, Slider, Modal, ModelPicker, Collapsible } from './components.jsx';
import { MemoryPanel } from './MemoryPanel.jsx';
import { PcFoldersPanel } from './PcFoldersPanel.jsx';

function MemoryTrace({ memory, onOpenMemory }) {
  if (!memory?.enabled) return null;
  const stats = memory.stats || {};
  const memories = stats.memoriesUsed ?? memory.memories?.length ?? 0;
  const chunks = stats.chunksUsed ?? memory.chunks?.length ?? 0;
  const summaries = stats.summariesUsed ?? memory.summaries ?? 0;
  const used = stats.contextTokens || memory.usedTokens || 0;
  const budget = stats.contextBudget || memory.budget || 0;
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

export default function App() {
  const [conversations, setConversations] = useState([]);
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
  const [team, setTeam] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamIds, setTeamIds] = useState(() => { try { return JSON.parse(localStorage.getItem('fred_team') || 'null'); } catch { return null; } });
  const teamRef = useRef(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [nowTick, setNowTick] = useState(0);
  const [dark, setDark] = useState(true);
  const [listening, setListening] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const [connError, setConnError] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
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
  const [tasks, setTasks] = useState([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const prevTasksRef = useRef([]);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const toastTimer = useRef(null);
  const copyTimer = useRef(null);
  const dragDepth = useRef(0);

  useEffect(() => { init(); }, []);
  useEffect(() => { document.body.className = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  // Enquanto processa, "bate um relógio" a cada segundo para os contadores vivos
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNowTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  // Fecha o painel da equipe ao clicar fora
  useEffect(() => {
    function onDoc(e) { if (teamRef.current && !teamRef.current.contains(e.target)) setTeamOpen(false); }
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
            if (r.conversation_id === current?.id) { openConversation(current.id); }
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
    if (!text || !current) return;
    if (listening) recognitionRef.current?.stop();
    setInput('');
    try {
      const res = await fetch(`${API}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: current.id, message: text, model, assistantId, webSearch }) });
      if (!res.ok) throw new Error();
      showToast('⏳ Tarefa adicionada à fila — acompanhe no botão "Tarefas".', 'ok');
      await pollTasks();
    } catch { showToast('Não foi possível criar a tarefa.'); }
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
    try { setTemplates(await (await fetch(`${API}/api/templates`)).json()); } catch {}
  }
  function openTemplates() { loadTemplates(); setTplOpen(true); }
  function useTemplate(t) { setInput(t.content); setTplOpen(false); inputRef.current?.focus(); }
  async function saveAsTemplate(m) {
    const name = prompt('Nome do template:', (m.content || '').slice(0, 40));
    if (!name?.trim()) return;
    try {
      await fetch(`${API}/api/templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), content: m.content }) });
      showToast(`Template "${name.trim()}" salvo! Acesse em Templates, na barra lateral.`);
    } catch { showToast('Não foi possível salvar o template.'); }
  }
  async function deleteTemplate(id, e) {
    e.stopPropagation();
    if (!confirm('Excluir este template?')) return;
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
      window.open(`${API}/api/conversations/${current.id}/download/${data.path}`, '_blank');
    } catch (e) {
      showToast(`Não foi possível exportar: ${e.message || 'erro inesperado'}`);
    } finally {
      setExporting(false);
    }
  }

  async function editMessage(m, idx) {
    const isSaved = m.id && !String(m.id).startsWith('local-');
    if (isSaved) {
      if (!confirm('Editar esta mensagem vai apagá-la junto com tudo o que veio depois nesta conversa, para regravar a partir daqui. Continuar?')) return;
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
      const rows = await fetchConversations();
      if (rows.length) await openConversation(rows[0].id);
      else await createConversation();
      loadModels();
      loadAssistants();
      loadClients();
    } catch (err) {
      if (err?.auth) setNeedLogin(true);
      else setConnError(true);
    }
  }

  // ---- Clientes / Projetos ----
  async function loadClients() {
    try { setClients(await (await fetch(`${API}/api/clients`)).json()); } catch {}
  }
  async function switchClient(id) {
    localStorage.setItem('fred_client', id);
    setClientId(id);
    try {
      const rows = await fetchConversations(id);
      if (rows.length) openConversation(rows[0].id);
      else createConversation(id);
    } catch {}
  }
  async function addClient() {
    const name = prompt('Nome do cliente ou projeto:');
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
    if (!confirm(`Remover o cliente "${c?.name || ''}"? As conversas dele NÃO são apagadas — voltam para "Geral".`)) return;
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
        setModel(prev => data.models.some(m => m.id === prev) ? prev : (data.models.find(m => m.tools !== false)?.id || data.models[0].id));
      }
    } catch {}
  }

  async function loadAssistants() {
    try {
      const res = await fetch(`${API}/api/assistants`);
      const rows = await res.json();
      setAssistants(rows);
      setAssistantId(prev => (prev && rows.some(a => a.id === prev)) ? prev : (rows[0]?.id || null));
      const chosen = rows.find(a => a.id === assistantId) || rows[0];
      if (chosen?.model) setModel(chosen.model);
    } catch {}
  }

  async function fetchConversations(cid = clientId) {
    const res = await fetch(`${API}/api/conversations${cid ? `?client=${encodeURIComponent(cid)}` : ''}`);
    if (res.status === 401) { const e = new Error('auth'); e.auth = true; throw e; }
    const rows = await res.json();
    setConversations(rows);
    return rows;
  }

  async function createConversation(cid = clientId) {
    try {
      const res = await fetch(`${API}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Nova conversa', model, clientId: cid || null }) });
      const c = await res.json();
      setConversations(prev => [c, ...prev]);
      setCurrent(c);
      setMessages([]);
      setFiles([]);
      setMenuOpen(false);
    } catch {
      showToast('Não foi possível criar a conversa. O servidor está no ar?');
    }
  }

  async function openConversation(id) {
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
    if (!confirm('Apagar esta conversa e todos os seus arquivos? Esta ação não pode ser desfeita.')) return;
    try {
      await fetch(`${API}/api/conversations/${id}`, { method: 'DELETE' });
      const rows = await fetchConversations();
      if (current?.id === id) { rows.length ? openConversation(rows[0].id) : createConversation(); }
    } catch {
      showToast('Não foi possível apagar a conversa.');
    }
  }

  async function loadFiles(id = current?.id) {
    if (!id) return;
    try {
      const res = await fetch(`${API}/api/conversations/${id}/files`);
      setFiles(await res.json());
    } catch {}
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
    if (!confirm(`Excluir o arquivo "${f.name}"?`)) return;
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
    if (!current) { showToast('Abra uma conversa antes de anexar arquivos.'); return; }
    setUploadingFiles(true);
    try {
      const fd = new FormData();
      filesToUpload.forEach(f => fd.append('files', f));
      const res = await fetch(`${API}/api/conversations/${current.id}/upload`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error();
      await loadFiles();
      if (source !== 'input') showToast(`${filesToUpload.length} arquivo(s) anexado(s).`, 'ok');
    } catch {
      showToast('Falha no envio do arquivo. Verifique o tamanho (máx. 50 MB) e tente de novo.');
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
    setForm({ id: a.id, name: a.name, emoji: a.emoji || '🤖', model: a.model || model, system_prompt: a.system_prompt || '', template: '', tools: a.tools?.length ? a.tools : TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20, ...(a.personality || {}) } });
    setStudioOpen(true);
  }
  function applyTemplate(key) {
    const t = TEMPLATES.find(x => x.key === key);
    if (!t) { setForm(f => ({ ...f, template: '' })); return; }
    setForm(f => ({ ...f, template: key, system_prompt: t.prompt, emoji: f.emoji === '🤖' ? t.emoji : f.emoji, name: f.name || t.label }));
  }
  function toggleTool(name) {
    setForm(f => ({ ...f, tools: f.tools.includes(name) ? f.tools.filter(t => t !== name) : [...f.tools, name] }));
  }
  function setSlider(key, val) { setForm(f => ({ ...f, personality: { ...f.personality, [key]: Number(val) } })); }

  async function saveAssistant() {
    if (!form.name.trim() || !form.system_prompt.trim()) { showToast('Preencha o nome e as instruções do assistente.'); return; }
    try {
      const payload = { name: form.name, emoji: form.emoji, model: form.model || model, system_prompt: form.system_prompt, tools: form.tools, personality: form.personality };
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
    if (!confirm('Excluir este assistente?')) return;
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
    if (!current) return;
    if (action === 'pause') setPaused(true);
    if (action === 'resume') setPaused(false);
    if (action === 'stop') setPaused(false);
    try { await fetch(`${API}/api/conversations/${current.id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }); } catch {}
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy || !current) return;
    if (team && effectiveTeam.length === 0) { showToast('Selecione ao menos 1 assistente no painel da Equipe.'); return; }
    if (listening) recognitionRef.current?.stop();
    setInput('');
    setBusy(true);
    setPaused(false);
    setStatusText('Pensando...');
    const assistantMsgId = `local-${Date.now()}`;
    setMessages(prev => [...prev, { role: 'user', content: text }, { id: assistantMsgId, role: 'assistant', content: '', blocks: [] }]);
    const update = (fn) => setMessages(prev => prev.map(m => m.id === assistantMsgId ? fn(m) : m));

    const body = team
      ? { message: text, model, orchestrate: true, orchestrateIds: effectiveTeam.map(a => a.id) }
      : { message: text, model, assistantId, webSearch };
    try {
      const res = await fetch(`${API}/api/conversations/${current.id}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (res.status === 401) { setBusy(false); setStatusText(''); setNeedLogin(true); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          if (!part.startsWith('data:')) continue;
          const ev = JSON.parse(part.slice(5));
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
            for (let i = blocks.length - 1; i >= 0; i--) { if (blocks[i].type === 'tool' && blocks[i].status === 'running') { blocks[i] = { ...blocks[i], status: 'done', ended: Date.now(), result: ev.content }; break; } }
            return { ...m, blocks };
          });
          if (ev.type === 'files') update(m => ({ ...m, files: [...(m.files || []), ...ev.files] }));
          if (ev.type === 'saved') setMessages(prev => {
            const arr = [...prev];
            const ai = arr.findIndex(m => m.id === assistantMsgId);
            if (ai > -1) { arr[ai] = { ...arr[ai], id: ev.assistantMessageId }; if (arr[ai - 1]?.role === 'user') arr[ai - 1] = { ...arr[ai - 1], id: ev.userMessageId }; }
            return arr;
          });
          if (ev.type === 'error') update(m => ({ ...m, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Erro:** ${ev.content}` }] }));
        }
      }
    } catch (err) {
      update(m => ({ ...m, blocks: [...(m.blocks || []), { type: 'text', content: `\n\n**Conexão interrompida:** ${err.message}` }] }));
    }
    // Fecha qualquer ferramenta que tenha ficado "rodando"
    update(m => ({ ...m, blocks: (m.blocks || []).map(b => b.type === 'tool' && b.status === 'running' ? { ...b, status: 'done', ended: Date.now() } : b) }));
    setBusy(false);
    setPaused(false);
    setStatusText('');
    await loadFiles();
    try {
      const rows = await fetchConversations();
      const updated = rows.find(c => c.id === current.id);
      if (updated) setCurrent(updated);
    } catch {}
  }

  const currentAssistant = assistants.find(a => a.id === assistantId);
  const uploads = files.filter(f => f.kind === 'upload');

  // Tela de login (produção com APP_PASSWORD definida)
  if (needLogin) {
    return <div className="connError">
      <form className="connErrorCard" onSubmit={doLogin}>
        <div className="brand" style={{ marginBottom: 0 }}>Frederico <span>AI Studio</span></div>
        <p>Digite a senha de acesso para entrar.</p>
        <input className="loginInput" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Senha" autoFocus/>
        {loginError && <p className="loginError">{loginError}</p>}
        <button className="primary" type="submit">Entrar</button>
      </form>
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

  return <div className="app">
    {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)}/>}
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
      <div className="brand">Frederico <span>AI Studio</span></div>
      <div className="clientRow">
        <select value={clientId} onChange={e => switchClient(e.target.value)} title="Cliente / Projeto ativo">
          <option value="">🗂️ Geral (sem cliente)</option>
          {clients.map(c => <option key={c.id} value={c.id}>👤 {c.name}</option>)}
        </select>
        <button onClick={addClient} title="Novo cliente/projeto" aria-label="Novo cliente"><Plus size={14}/></button>
        {clientId && <button className="clientDel" onClick={removeClient} title="Remover cliente (conversas voltam para Geral)" aria-label="Remover cliente"><Trash2 size={14}/></button>}
      </div>
      <button className="new" onClick={() => createConversation()}><Plus size={16}/> Nova conversa</button>
      <div className="convList">
        {conversations.length === 0 && <p className="muted small">Suas conversas aparecerão aqui.</p>}
        {conversations.map(c => (
          <div key={c.id} className={`convItem ${current?.id === c.id ? 'active' : ''}`}>
            <button className="convOpen" onClick={() => openConversation(c.id)} title={c.title}>{c.title}</button>
            <button className="convDel" onClick={(e) => deleteConversation(c.id, e)} title="Apagar conversa" aria-label="Apagar conversa"><Trash2 size={15}/></button>
          </div>
        ))}
      </div>
      <button className="studio" onClick={openStudioNew}><Bot size={16}/> Criar assistente</button>
      <button className="studio" onClick={openTemplates}><BookMarked size={16}/> Templates</button>
      <button className="studio" onClick={() => setMemoryOpen(true)}><Brain size={16}/> Memória</button>
      <button className="studio" onClick={() => setPcOpen(true)} title="Libere pastas do seu PC para o assistente procurar, ler e organizar arquivos"><FolderCog size={16}/> Pastas do PC</button>
      <button className="studio" onClick={() => { setTasksOpen(true); pollTasks(); }}><ListTodo size={16}/> Tarefas{tasksActive && <span className="badge">{tasks.filter(t => t.status === 'queued' || t.status === 'running').length}</span>}</button>
      <button className="studio" onClick={openAnalytics}><BarChart3 size={16}/> Análises</button>
      <button className="studio" onClick={() => window.open(`${API}/api/backup`, '_blank')} title="Baixa um arquivo .tar.gz com o banco e todos os workspaces"><HardDriveDownload size={16}/> Backup</button>
      <button className="theme" onClick={() => setDark(!dark)}>{dark ? <Sun size={16}/> : <Moon size={16}/>} Tema</button>
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
        <button className="hamburger" onClick={() => setMenuOpen(o => !o)} aria-label="Abrir menu"><Menu size={19}/></button>
        <div className="titleblock"><strong>{current?.title || 'Conversa'}</strong><small>{team ? `🧑‍🤝‍🧑 Equipe (${assistants.length} assistentes)` : (currentAssistant ? `${currentAssistant.emoji || '🤖'} ${currentAssistant.name}` : 'Assistente')} · {model}</small></div>
        <div className="pickers">
          <div className="mpicker" ref={teamRef}>
            <button className={`teamBtn ${team ? 'on' : ''}`} onClick={() => setTeamOpen(o => !o)} title="Modo Equipe: escolha os assistentes e junte as perspectivas"><Users size={15}/> Equipe{team ? ` (${effectiveTeam.length})` : ''}</button>
            {teamOpen && <div className="mpPanel teamPanel">
              <label className="chk teamSwitch"><input type="checkbox" checked={team} onChange={e => setTeam(e.target.checked)}/> <b>Modo Equipe ativado</b></label>
              <div className="teamHint">Quem participa da consulta:</div>
              {assistants.map(a => (
                <label key={a.id} className="chk">
                  <input type="checkbox" checked={!teamIds || teamIds.includes(a.id)} onChange={() => toggleTeamMember(a.id)}/> {a.emoji || '🤖'} {a.name}
                </label>
              ))}
              <div className="teamHint">💡 A equipe completa é consultada só na <b>1ª mensagem</b> da conversa; depois o coordenador continua sozinho (sem gastar tokens). Escreva <b>"consulte a equipe"</b> quando quiser uma nova rodada.</div>
            </div>}
          </div>
          <select value={assistantId || ''} onChange={e => pickAssistant(e.target.value)} disabled={team} title="Assistente">
            {assistants.map(a => <option key={a.id} value={a.id}>{a.emoji || '🤖'} {a.name}</option>)}
          </select>
          <button className="gear" onClick={() => currentAssistant ? openStudioEdit(currentAssistant) : openStudioNew()} title="Editar assistente" disabled={team}><Settings size={16}/></button>
          <div className="mpicker">
            <button className="gear" onClick={() => setExportOpen(o => !o)} title="Exportar conversa" disabled={exporting}>{exporting ? <span className="spin sm"/> : <FileDown size={16}/>}</button>
            {exportOpen && <div className="mpPanel exportPanel">
              <button className="mpItem" onClick={() => exportConv('pdf')}><span className="mpItemName">📄 Exportar como PDF</span></button>
              <button className="mpItem" onClick={() => exportConv('docx')}><span className="mpItemName">📝 Exportar como Word (.docx)</span></button>
            </div>}
          </div>
          <ModelPicker models={allModels} value={model} onChange={setModel}/>
        </div>
      </header>
      <section className="messages">
        {loadingConv && <div className="working"><span className="spin"/><span>Carregando conversa...</span></div>}
        {!loadingConv && messages.length === 0 && !busy && <div className="welcome">
          <div className="welcomeIcon"><Sparkles size={26}/></div>
          <h2>Como posso ajudar hoje?</h2>
          <p>Envie um arquivo, peça uma planilha, um documento ou uma análise. Sugestões:</p>
          <div className="suggestions">
            {SUGGESTIONS.map((s, i) => <button key={i} onClick={() => setInput(s)}>{s}</button>)}
          </div>
        </div>}
        {messages.map((m, idx) => (
          <div key={m.id || idx} className={`msg ${m.role}`}>
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
            {m.role === 'assistant' && <MemoryTrace memory={m.memory} onOpenMemory={() => setMemoryOpen(true)}/>}
            {m.files?.length > 0 && <div className="filecards">
              {m.files.map(f => {
                const url = `${API}/api/conversations/${current?.id}/download/${f.path}`;
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
        ))}
        {busy && <div className="working">
          {paused ? <span className="pausedDot"/> : <span className="spin"/>}
          <span>{paused ? 'Pausado' : (statusText || 'Processando...')}</span>
          <div className="workctl">
            {!paused
              ? <button onClick={() => control('pause')} title="Pausar após a etapa atual"><Pause size={14}/> Pausar</button>
              : <button onClick={() => control('resume')} title="Continuar"><Play size={14}/> Continuar</button>}
            <button className="stopBtn" onClick={() => control('stop')} title="Parar o processamento"><Square size={13}/> Parar</button>
          </div>
        </div>}
        <div ref={endRef}/>
      </section>
      <footer className="composerWrap">
        {uploads.length > 0 && <div className="attachChips">
          {uploads.map(f => <span className="attachChip" key={f.id}>
            <FileText size={13}/><span className="chipname" title={f.name}>{f.name}</span>
            <button onClick={() => deleteFile(f)} aria-label="Remover anexo"><X size={12}/></button>
          </span>)}
        </div>}
        {uploadingFiles && <div className="attachStatus"><span className="spin sm"/><span>Anexando arquivo...</span></div>}
        <div className="composer">
          <label className="upload" title="Anexar arquivo"><Upload size={18}/><input type="file" multiple onChange={uploadFiles}/></label>
          <button className={`webBtn ${webSearch ? 'on' : ''}`} onClick={() => setWebSearch(w => !w)} title={webSearch ? 'Pesquisa na internet ATIVADA — clique para desativar' : 'Ativar pesquisa na internet'} aria-label="Pesquisa na internet"><Globe size={18}/></button>
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} placeholder={listening ? 'Ouvindo... fale agora' : (webSearch ? 'Pesquisa na internet ativada — pergunte algo atual...' : 'Peça para analisar arquivos, gerar Word, Excel, PDF...')} />
          <button className={`mic ${listening ? 'on' : ''}`} onClick={toggleMic} title="Falar (ditado por voz)" aria-label="Ditado por voz"><Mic size={18}/></button>
          <button className="mic" onClick={sendAsTask} disabled={!input.trim()} title="Executar em segundo plano (fila de tarefas) — você pode continuar usando o app" aria-label="Enviar para a fila de tarefas"><Hourglass size={17}/></button>
          <button className="sendBtn" onClick={sendMessage} disabled={busy} aria-label="Enviar"><Send size={18}/></button>
        </div>
      </footer>
    </main>

    {toast && <div className={`toast ${toast.kind || 'err'}`} role="alert">{toast.text}<button onClick={() => setToast(null)} aria-label="Fechar aviso"><X size={14}/></button></div>}

    {studioOpen && <Modal title={form.id ? 'Editar assistente' : 'Novo assistente'} icon={<Bot size={18}/>} onClose={() => setStudioOpen(false)}>
      <div className="frow">
        <label className="grow">Nome
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex.: Assistente Contábil"/>
        </label>
        <label className="emojiField">Ícone
          <input value={form.emoji} onChange={e => setForm(f => ({ ...f, emoji: e.target.value }))} maxLength={2}/>
        </label>
      </div>

      <label>Modelo de IA padrão
        <select value={form.model || model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))}>
          {allModels.filter(m => m.tools !== false).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>

      <label>Começar de um template
        <select value={form.template || ''} onChange={e => applyTemplate(e.target.value)}>
          <option value="">— escolher um modelo pronto —</option>
          {TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.emoji} {t.label}</option>)}
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

    {memoryOpen && <MemoryPanel assistants={assistants} clients={clients} clientId={clientId} showToast={showToast} onClose={() => setMemoryOpen(false)}/>}
    {pcOpen && <PcFoldersPanel showToast={showToast} onClose={() => setPcOpen(false)}/>}

    {analyticsOpen && <Modal title="Análises de uso" icon={<BarChart3 size={18}/>} onClose={() => setAnalyticsOpen(false)}>
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
            <tbody>{(analytics.byAssistant || []).map((r, i) => <tr key={i}><td>{r.emoji ? `${r.emoji} ` : ''}{r.name}</td><td>{r.messages}</td><td>{(r.tokens || 0).toLocaleString('pt-BR')}</td></tr>)}
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
    </Modal>}

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

    {tasksOpen && <Modal title="Fila de tarefas" icon={<ListTodo size={18}/>} onClose={() => setTasksOpen(false)}>
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
    </Modal>}
  </div>;
}
