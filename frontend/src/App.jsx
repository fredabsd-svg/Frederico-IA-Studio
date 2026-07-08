import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Download, FileText, Plus, Send, Upload, Moon, Sun, Trash2 } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Modelos do OpenRouter. Todos os listados suportam "ferramentas" (tool calling),
// requisito para gerar Excel/Word/PDF. Você pode acrescentar outros IDs do
// catálogo em https://openrouter.ai/models — evite modelos de "raciocínio"
// (ex.: deepseek/deepseek-r1), que não geram arquivos.
const MODELS = [
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat — econômico, gera arquivos' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini — rápido e barato (OpenAI)' },
  { id: 'openai/gpt-4o', label: 'GPT-4o — mais capaz (OpenAI)' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet — ótimo em texto' },
  { id: 'google/gemini-flash-1.5', label: 'Gemini 1.5 Flash — Google' }
];

export default function App() {
  const [conversations, setConversations] = useState([]);
  const [current, setCurrent] = useState(null);
  const [messages, setMessages] = useState([]);
  const [files, setFiles] = useState([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(MODELS[0].id);
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(true);
  const endRef = useRef(null);

  useEffect(() => { init(); }, []);
  useEffect(() => { document.body.className = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function init() {
    const rows = await fetchConversations();
    if (rows.length) openConversation(rows[0].id);
    else createConversation();
  }

  // Só atualiza a lista da barra lateral (sem trocar de conversa)
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
    if (current?.id === id) {
      if (rows.length) openConversation(rows[0].id);
      else createConversation();
    }
  }

  async function loadFiles(id = current?.id) {
    if (!id) return;
    const res = await fetch(`${API}/api/conversations/${id}/files`);
    setFiles(await res.json());
  }

  async function uploadFiles(e) {
    const selected = [...e.target.files];
    if (!selected.length || !current) return;
    const form = new FormData();
    selected.forEach(f => form.append('files', f));
    await fetch(`${API}/api/conversations/${current.id}/upload`, { method: 'POST', body: form });
    await loadFiles();
    e.target.value = '';
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy || !current) return;
    setInput('');
    setBusy(true);
    const assistantId = `local-${Date.now()}`;
    setMessages(prev => [...prev, { role: 'user', content: text }, { id: assistantId, role: 'assistant', content: '' }]);

    const res = await fetch(`${API}/api/conversations/${current.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, model })
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
        if (ev.type === 'delta') {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: (m.content || '') + ev.content } : m));
        }
        if (ev.type === 'tool_start') {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: (m.content || '') + `\n\n> Executando ferramenta: ${ev.name}\n` } : m));
        }
        if (ev.type === 'error') {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: (m.content || '') + `\n\nErro: ${ev.content}` } : m));
        }
      }
    }
    setBusy(false);
    await loadFiles();
    // Atualiza a barra lateral para refletir o título automático da conversa
    const rows = await fetchConversations();
    const updated = rows.find(c => c.id === current.id);
    if (updated) setCurrent(updated);
  }

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
      <button className="theme" onClick={() => setDark(!dark)}>{dark ? <Sun size={16}/> : <Moon size={16}/>} Tema</button>
    </aside>

    <main className="chat">
      <header className="topbar">
        <div><strong>{current?.title || 'Conversa'}</strong><small>Modelo ativo: {model}</small></div>
        <select value={model} onChange={e => setModel(e.target.value)} title="Escolha a IA (OpenRouter)">
          {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
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
  </div>;
}
