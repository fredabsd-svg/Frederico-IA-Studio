import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Download, FileText, Plus, Send, Upload, Moon, Sun, Trash2, Settings, Bot, Brain, X, BarChart3, Users, Pause, Play, Square, Mic } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Lista de reserva, usada só se a busca do catálogo do provedor falhar.
const FALLBACK_MODELS = [
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', tools: true },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', tools: true },
  { id: 'openai/gpt-4o', name: 'GPT-4o', tools: true },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', tools: true },
  { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash', tools: true }
];

// Ferramentas que um assistente pode ter acesso
const TOOL_INFO = [
  { name: 'run_python', label: 'Executar Python' },
  { name: 'bash', label: 'Comandos bash' },
  { name: 'write_file', label: 'Escrever arquivos' },
  { name: 'read_file', label: 'Ler arquivos' },
  { name: 'list_files', label: 'Listar arquivos' },
  { name: 'zip_outputs', label: 'Compactar (.zip)' }
];

// Templates prontos de system prompt
const TEMPLATES = [
  { key: 'contabil', label: 'Contábil / Fiscal', emoji: '📊', prompt: 'Você é um assistente contábil e fiscal brasileiro. Domine regimes tributários (Simples, Lucro Presumido e Real), obrigações acessórias, SPED, escrituração e conciliações. Responda em português do Brasil, cite a base legal quando relevante e gere planilhas/relatórios reais quando pedido.' },
  { key: 'juridico', label: 'Jurídico', emoji: '⚖️', prompt: 'Você é um assistente jurídico brasileiro. Ajude com análise de contratos, petições, pareceres e pesquisa de legislação. Responda em português do Brasil, seja preciso, cite artigos e leis, e sempre recomende a revisão por um advogado responsável.' },
  { key: 'rh', label: 'Recursos Humanos', emoji: '👥', prompt: 'Você é um assistente de RH e Departamento Pessoal no Brasil. Ajude com folha de pagamento, admissões/demissões, eSocial, férias, benefícios e legislação trabalhista (CLT). Responda em português do Brasil, de forma clara e prática.' },
  { key: 'marketing', label: 'Marketing', emoji: '📣', prompt: 'Você é um assistente de marketing e conteúdo. Ajude a criar textos, campanhas, posts, e-mails e estratégias. Responda em português do Brasil, com tom persuasivo e criativo, adaptando a linguagem ao público-alvo.' },
  { key: 'dev', label: 'Programação', emoji: '💻', prompt: 'Você é um engenheiro de software sênior com um sandbox Linux real. Escreva, execute e teste código (Python/shell) usando as ferramentas, verifique o resultado e corrija erros antes de responder. A sandbox NÃO tem internet: use a biblioteca padrão e os pacotes já instalados. Responda em português do Brasil, objetivo e técnico.' },
  { key: 'geral', label: 'Uso geral', emoji: '🤖', prompt: 'Você é um assistente pessoal versátil e prestativo. Responda em português do Brasil, de forma clara e útil. Quando o usuário pedir arquivos (Excel, Word, PDF), gere-os de verdade usando as ferramentas disponíveis.' }
];

const emptyForm = () => ({ id: null, name: '', emoji: '🤖', model: '', system_prompt: '', template: '', tools: TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20 } });

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
  const [memoryItems, setMemoryItems] = useState([]);
  const [memoryInput, setMemoryInput] = useState('');
  const [memoryScope, setMemoryScope] = useState('global');
  const [team, setTeam] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [nowTick, setNowTick] = useState(0);
  const [dark, setDark] = useState(true);
  const [listening, setListening] = useState(false);
  const endRef = useRef(null);
  const recognitionRef = useRef(null);

  useEffect(() => { init(); loadModels(); loadAssistants(); loadMemory(); }, []);
  useEffect(() => { document.body.className = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  // Enquanto processa, "bate um relógio" a cada segundo para os contadores vivos
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNowTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function init() {
    const rows = await fetchConversations();
    if (rows.length) openConversation(rows[0].id);
    else createConversation();
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

  async function fetchConversations() {
    const res = await fetch(`${API}/api/conversations`);
    const rows = await res.json();
    setConversations(rows);
    return rows;
  }

  async function createConversation() {
    const res = await fetch(`${API}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Nova conversa', model }) });
    const c = await res.json();
    setConversations(prev => [c, ...prev]);
    setCurrent(c);
    setMessages([]);
    setFiles([]);
  }

  async function openConversation(id) {
    const res = await fetch(`${API}/api/conversations/${id}`);
    const data = await res.json();
    setCurrent(data.conversation);
    setMessages(data.messages || []);
    loadFiles(id);
  }

  async function deleteConversation(id, e) {
    e.stopPropagation();
    if (!confirm('Apagar esta conversa e todos os seus arquivos? Esta ação não pode ser desfeita.')) return;
    await fetch(`${API}/api/conversations/${id}`, { method: 'DELETE' });
    const rows = await fetchConversations();
    if (current?.id === id) { rows.length ? openConversation(rows[0].id) : createConversation(); }
  }

  async function loadFiles(id = current?.id) {
    if (!id) return;
    const res = await fetch(`${API}/api/conversations/${id}/files`);
    setFiles(await res.json());
  }

  // ---- Ditado por voz (Web Speech API) ----
  function toggleMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Seu navegador não suporta ditado por voz. Use o Google Chrome ou o Microsoft Edge.'); return; }
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
    const encoded = f.path.split('/').map(encodeURIComponent).join('/');
    await fetch(`${API}/api/conversations/${current.id}/files/${encoded}`, { method: 'DELETE' });
    await loadFiles();
  }

  async function uploadFiles(e) {
    const selected = [...e.target.files];
    if (!selected.length || !current) return;
    const fd = new FormData();
    selected.forEach(f => fd.append('files', f));
    await fetch(`${API}/api/conversations/${current.id}/upload`, { method: 'POST', body: fd });
    await loadFiles();
    e.target.value = '';
  }

  function pickAssistant(id) {
    setAssistantId(id);
    const a = assistants.find(x => x.id === id);
    if (a?.model) setModel(a.model);
  }

  // ---- Assistant Studio ----
  function openStudioNew() { setForm(emptyForm()); setStudioOpen(true); }
  function openStudioEdit(a) {
    setForm({ id: a.id, name: a.name, emoji: a.emoji || '🤖', model: a.model || model, system_prompt: a.system_prompt || '', tools: a.tools?.length ? a.tools : TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20, ...(a.personality || {}) } });
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
    if (!form.name.trim() || !form.system_prompt.trim()) { alert('Preencha o nome e as instruções do assistente.'); return; }
    const payload = { name: form.name, emoji: form.emoji, model: form.model || model, system_prompt: form.system_prompt, tools: form.tools, personality: form.personality };
    const url = form.id ? `${API}/api/assistants/${form.id}` : `${API}/api/assistants`;
    const saved = await (await fetch(url, { method: form.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
    await loadAssistants();
    if (saved?.id) pickAssistant(saved.id);
    setStudioOpen(false);
  }

  async function deleteAssistant() {
    if (!form.id) return;
    if (!confirm('Excluir este assistente?')) return;
    await fetch(`${API}/api/assistants/${form.id}`, { method: 'DELETE' });
    setStudioOpen(false);
    const res = await fetch(`${API}/api/assistants`);
    const rows = await res.json();
    setAssistants(rows);
    if (assistantId === form.id) pickAssistant(rows[0]?.id || null);
  }

  // ---- Memória (global ou por assistente) ----
  async function loadMemory(scope = memoryScope) {
    try { setMemoryItems(await (await fetch(`${API}/api/memory?scope=${encodeURIComponent(scope)}`)).json()); } catch {}
  }
  function changeMemoryScope(scope) { setMemoryScope(scope); loadMemory(scope); }
  async function addMemory() {
    const content = memoryInput.trim();
    if (!content) return;
    setMemoryInput('');
    await fetch(`${API}/api/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, scope: memoryScope }) });
    await loadMemory();
  }
  async function removeMemory(id) {
    await fetch(`${API}/api/memory/${id}`, { method: 'DELETE' });
    await loadMemory();
  }

  // ---- Analytics ----
  async function openAnalytics() {
    setAnalyticsOpen(true);
    try { setAnalytics(await (await fetch(`${API}/api/analytics`)).json()); } catch {}
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
    if (listening) recognitionRef.current?.stop();
    setInput('');
    setBusy(true);
    setPaused(false);
    setStatusText('Pensando...');
    const assistantMsgId = `local-${Date.now()}`;
    setMessages(prev => [...prev, { role: 'user', content: text }, { id: assistantMsgId, role: 'assistant', content: '', blocks: [] }]);
    const update = (fn) => setMessages(prev => prev.map(m => m.id === assistantMsgId ? fn(m) : m));

    const body = team
      ? { message: text, model, orchestrate: true, orchestrateIds: assistants.map(a => a.id) }
      : { message: text, model, assistantId };
    try {
      const res = await fetch(`${API}/api/conversations/${current.id}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
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
          if (ev.type === 'delta') update(m => {
            const blocks = [...(m.blocks || [])];
            const last = blocks[blocks.length - 1];
            if (last && last.type === 'text') blocks[blocks.length - 1] = { ...last, content: last.content + ev.content };
            else blocks.push({ type: 'text', content: ev.content });
            return { ...m, blocks, content: (m.content || '') + ev.content };
          });
          if (ev.type === 'tool_start') { setStatusText(`Executando ${ev.name}...`); update(m => ({ ...m, blocks: [...(m.blocks || []), { type: 'tool', name: ev.name, status: 'running', started: Date.now() }] })); }
          if (ev.type === 'tool_result') update(m => {
            const blocks = [...(m.blocks || [])];
            for (let i = blocks.length - 1; i >= 0; i--) { if (blocks[i].type === 'tool' && blocks[i].status === 'running') { blocks[i] = { ...blocks[i], status: 'done', ended: Date.now() }; break; } }
            return { ...m, blocks };
          });
          if (ev.type === 'files') update(m => ({ ...m, files: [...(m.files || []), ...ev.files] }));
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
    const rows = await fetchConversations();
    const updated = rows.find(c => c.id === current.id);
    if (updated) setCurrent(updated);
  }

  const currentAssistant = assistants.find(a => a.id === assistantId);
  const uploads = files.filter(f => f.kind === 'upload');

  return <div className="app">
    <aside className="sidebar">
      <div className="brand">Frederico <span>AI Studio</span></div>
      <button className="new" onClick={createConversation}><Plus size={16}/> Nova conversa</button>
      <div className="convList">
        {conversations.map(c => (
          <div key={c.id} className={`convItem ${current?.id === c.id ? 'active' : ''}`}>
            <button className="convOpen" onClick={() => openConversation(c.id)} title={c.title}>{c.title}</button>
            <button className="convDel" onClick={(e) => deleteConversation(c.id, e)} title="Apagar conversa" aria-label="Apagar conversa"><Trash2 size={15}/></button>
          </div>
        ))}
      </div>
      <button className="studio" onClick={openStudioNew}><Bot size={16}/> Criar assistente</button>
      <button className="studio" onClick={() => { setMemoryScope('global'); loadMemory('global'); setMemoryOpen(true); }}><Brain size={16}/> Memória</button>
      <button className="studio" onClick={openAnalytics}><BarChart3 size={16}/> Análises</button>
      <button className="theme" onClick={() => setDark(!dark)}>{dark ? <Sun size={16}/> : <Moon size={16}/>} Tema</button>
    </aside>

    <main className="chat">
      <header className="topbar">
        <div className="titleblock"><strong>{current?.title || 'Conversa'}</strong><small>{team ? `🧑‍🤝‍🧑 Equipe (${assistants.length} assistentes)` : (currentAssistant ? `${currentAssistant.emoji || '🤖'} ${currentAssistant.name}` : 'Assistente')} · {model}</small></div>
        <div className="pickers">
          <button className={`teamBtn ${team ? 'on' : ''}`} onClick={() => setTeam(t => !t)} title="Modo Equipe: aciona todos os assistentes e junta as respostas"><Users size={15}/> Equipe</button>
          <select value={assistantId || ''} onChange={e => pickAssistant(e.target.value)} disabled={team} title="Assistente">
            {assistants.map(a => <option key={a.id} value={a.id}>{a.emoji || '🤖'} {a.name}</option>)}
          </select>
          <button className="gear" onClick={() => currentAssistant ? openStudioEdit(currentAssistant) : openStudioNew()} title="Editar assistente" disabled={team}><Settings size={16}/></button>
          <select value={model} onChange={e => setModel(e.target.value)} title="Modelo de IA">
            <optgroup label="✅ Geram arquivos (recomendados)">
              {allModels.filter(m => m.tools !== false).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </optgroup>
            {allModels.some(m => m.tools === false) && (
              <optgroup label="💬 Só conversa (não geram arquivos)">
                {allModels.filter(m => m.tools === false).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </optgroup>
            )}
          </select>
        </div>
      </header>
      <section className="messages">
        {messages.map((m, idx) => (
          <div key={m.id || idx} className={`msg ${m.role}`}>
            {m.blocks
              ? m.blocks.map((b, i) => b.type === 'tool'
                ? <ToolStep key={i} step={b} nowTick={nowTick}/>
                : <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{b.content || ''}</ReactMarkdown>)
              : <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{m.content || ''}</ReactMarkdown>}
            {m.files?.length > 0 && <div className="filecards">
              {m.files.map(f => <a className="filecard" key={f.id || f.path} href={`${API}/api/conversations/${current?.id}/download/${f.path}`} target="_blank">
                <span className="fcicon"><FileText size={20}/></span>
                <span className="fcinfo"><b>{f.name}</b><small>{Math.ceil((f.size || 0) / 1024)} KB</small></span>
                <span className="fcdl"><Download size={16}/> Baixar</span>
              </a>)}
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
        <div className="composer">
          <label className="upload" title="Anexar arquivo"><Upload size={18}/><input type="file" multiple onChange={uploadFiles}/></label>
          <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} placeholder={listening ? 'Ouvindo... fale agora' : 'Peça para analisar arquivos, gerar Word, Excel, PDF...'} />
          <button className={`mic ${listening ? 'on' : ''}`} onClick={toggleMic} title="Falar (ditado por voz)" aria-label="Ditado por voz"><Mic size={18}/></button>
          <button onClick={sendMessage} disabled={busy}><Send size={18}/></button>
        </div>
      </footer>
    </main>

    {studioOpen && <div className="modalOverlay" onClick={() => setStudioOpen(false)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modalHead">
          <h2><Bot size={18}/> {form.id ? 'Editar assistente' : 'Novo assistente'}</h2>
          <button className="x" onClick={() => setStudioOpen(false)} aria-label="Fechar">✕</button>
        </div>
        <div className="modalBody">
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
        </div>
      </div>
    </div>}

    {memoryOpen && <div className="modalOverlay" onClick={() => setMemoryOpen(false)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modalHead">
          <h2><Brain size={18}/> Memória</h2>
          <button className="x" onClick={() => setMemoryOpen(false)} aria-label="Fechar">✕</button>
        </div>
        <div className="modalBody">
          <label>Onde guardar
            <select value={memoryScope} onChange={e => changeMemoryScope(e.target.value)}>
              <option value="global">🌐 Global — todos os assistentes lembram</option>
              {assistants.map(a => <option key={a.id} value={a.id}>{a.emoji || '🤖'} Só do assistente: {a.name}</option>)}
            </select>
          </label>
          <p className="muted" style={{ margin: 0 }}>{memoryScope === 'global' ? 'Informações que TODOS os assistentes lembram em todas as conversas (ex.: CNPJ, regime tributário, preferências).' : 'Memória exclusiva deste assistente — só ele usa (ex.: decisões técnicas, particularidades do setor).'}</p>
          <div className="memAdd">
            <input value={memoryInput} onChange={e => setMemoryInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMemory(); } }} placeholder="Ex.: Minha empresa é a Frederico Assessoria, CNPJ 00.000.000/0001-00, Simples Nacional."/>
            <button className="primary" onClick={addMemory}>Adicionar</button>
          </div>
          <div className="memList">
            {memoryItems.length === 0 && <p className="muted">Nenhuma informação salva ainda.</p>}
            {memoryItems.map(m => (
              <div className="memItem" key={m.id}>
                <span>{m.content}</span>
                <button className="memDel" onClick={() => removeMemory(m.id)} aria-label="Remover"><X size={15}/></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>}

    {analyticsOpen && <div className="modalOverlay" onClick={() => setAnalyticsOpen(false)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modalHead">
          <h2><BarChart3 size={18}/> Análises de uso</h2>
          <button className="x" onClick={() => setAnalyticsOpen(false)} aria-label="Fechar">✕</button>
        </div>
        <div className="modalBody">
          {!analytics && <p className="muted">Carregando...</p>}
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
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>Tokens são a medida de consumo dos modelos. O custo em R$/US$ depende do preço de cada modelo no OpenRouter.</p>
          </>}
        </div>
      </div>
    </div>}
  </div>;
}

function ToolStep({ step }) {
  const end = step.ended || Date.now();
  const secs = Math.max(0, Math.round((end - step.started) / 1000));
  return <div className={`toolstep ${step.status}`}>
    <span className="ic">{step.status === 'running' ? <span className="spin sm"/> : '✓'}</span>
    <code>{step.name}</code>
    <span className="sec">{secs}s</span>
    {step.status === 'running' && <span className="lbl">executando…</span>}
  </div>;
}

function Slider({ label, hintA, hintB, value, onChange }) {
  return <div className="slider">
    <div className="sliderTop"><span>{label}</span><b>{value}</b></div>
    <input type="range" min="0" max="100" value={value} onChange={e => onChange(e.target.value)}/>
    <div className="sliderHints"><span>{hintA}</span><span>{hintB}</span></div>
  </div>;
}
