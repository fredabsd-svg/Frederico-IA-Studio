import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Download, FileText, Plus, Send, Upload, Moon, Sun, Trash2, Settings, Bot } from 'lucide-react';

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

const emptyForm = () => ({ id: null, name: '', emoji: '🤖', model: '', system_prompt: '', tools: TOOL_INFO.map(t => t.name), personality: { form: 50, det: 50, criat: 20 } });

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
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(true);
  const endRef = useRef(null);

  useEffect(() => { init(); loadModels(); loadAssistants(); }, []);
  useEffect(() => { document.body.className = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

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
    if (!t) return;
    setForm(f => ({ ...f, system_prompt: t.prompt, emoji: f.emoji === '🤖' ? t.emoji : f.emoji, name: f.name || t.label }));
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

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy || !current) return;
    setInput('');
    setBusy(true);
    const assistantMsgId = `local-${Date.now()}`;
    setMessages(prev => [...prev, { role: 'user', content: text }, { id: assistantMsgId, role: 'assistant', content: '' }]);

    const res = await fetch(`${API}/api/conversations/${current.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, model, assistantId })
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
        if (ev.type === 'delta') setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: (m.content || '') + ev.content } : m));
        if (ev.type === 'tool_start') setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: (m.content || '') + `\n\n> Executando ferramenta: ${ev.name}\n` } : m));
        if (ev.type === 'error') setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: (m.content || '') + `\n\nErro: ${ev.content}` } : m));
      }
    }
    setBusy(false);
    await loadFiles();
    const rows = await fetchConversations();
    const updated = rows.find(c => c.id === current.id);
    if (updated) setCurrent(updated);
  }

  const currentAssistant = assistants.find(a => a.id === assistantId);

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
      <button className="theme" onClick={() => setDark(!dark)}>{dark ? <Sun size={16}/> : <Moon size={16}/>} Tema</button>
    </aside>

    <main className="chat">
      <header className="topbar">
        <div className="titleblock"><strong>{current?.title || 'Conversa'}</strong><small>{currentAssistant ? `${currentAssistant.emoji || '🤖'} ${currentAssistant.name}` : 'Assistente'} · {model}</small></div>
        <div className="pickers">
          <select value={assistantId || ''} onChange={e => pickAssistant(e.target.value)} title="Assistente">
            {assistants.map(a => <option key={a.id} value={a.id}>{a.emoji || '🤖'} {a.name}</option>)}
          </select>
          <button className="gear" onClick={() => currentAssistant ? openStudioEdit(currentAssistant) : openStudioNew()} title="Editar assistente"><Settings size={16}/></button>
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
        {messages.map((m, idx) => <div key={m.id || idx} className={`msg ${m.role}`}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{m.content || ''}</ReactMarkdown></div>)}
        {busy && <div className="typing">pensando...</div>}
        <div ref={endRef}/>
      </section>
      <footer className="composer">
        <label className="upload"><Upload size={18}/><input type="file" multiple onChange={uploadFiles}/></label>
        <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} placeholder="Peça para analisar arquivos, gerar Word, Excel, PDF..." />
        <button onClick={sendMessage} disabled={busy}><Send size={18}/></button>
      </footer>
    </main>

    <aside className="artifacts">
      <h3>Arquivos</h3>
      {files.length === 0 && <p className="muted">Uploads e outputs aparecerão aqui.</p>}
      {files.map(f => <a className="file" key={`${f.path}-${f.id}`} href={`${API}/api/conversations/${current?.id}/download/${f.path}`} target="_blank">
        <FileText size={18}/><span>{f.name}</span><small>{Math.ceil((f.size || 0)/1024)} KB</small><Download size={16}/>
      </a>)}
    </aside>

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
            <select value="" onChange={e => applyTemplate(e.target.value)}>
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
  </div>;
}

function Slider({ label, hintA, hintB, value, onChange }) {
  return <div className="slider">
    <div className="sliderTop"><span>{label}</span><b>{value}</b></div>
    <input type="range" min="0" max="100" value={value} onChange={e => onChange(e.target.value)}/>
    <div className="sliderHints"><span>{hintA}</span><span>{hintB}</span></div>
  </div>;
}
