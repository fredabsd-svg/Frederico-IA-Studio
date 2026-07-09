import React, { useEffect, useRef, useState } from 'react';
import { Brain, Search, Pin, PinOff, Pencil, X, Download, Upload, RefreshCw, Trash2, Settings2 } from 'lucide-react';
import { API } from './constants.js';
import { Modal } from './components.jsx';

const TYPES = [
  { key: '', label: 'Todas' },
  { key: 'perfil', label: '👤 Perfil' },
  { key: 'preferencia', label: '⭐ Preferências' },
  { key: 'projeto', label: '🏗️ Projetos' },
  { key: 'fato', label: '💡 Fatos' },
  { key: 'manual', label: '✍️ Manuais' }
];
const TYPE_BADGE = { perfil: '👤 Perfil', preferencia: '⭐ Preferência', projeto: '🏗️ Projeto', fato: '💡 Fato', manual: '✍️ Manual' };
const SOURCE_LABEL = { manual: 'adicionada por você', auto: 'aprendida das conversas', import: 'importada' };

// Cérebro do Assistente: tudo o que o app sabe, com busca, edição e controles
export function MemoryPanel({ assistants, clients, clientId, showToast, onClose }) {
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newScope, setNewScope] = useState('global');
  const [config, setConfig] = useState(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [workingLabel, setWorkingLabel] = useState('');
  const fileRef = useRef(null);
  const searchTimer = useRef(null);

  useEffect(() => { load(); loadConfig(); }, []);
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(load, 350);
    return () => clearTimeout(searchTimer.current);
  }, [query, type]);

  async function load() {
    try {
      const p = new URLSearchParams();
      if (query.trim()) p.set('query', query.trim());
      if (type) p.set('type', type);
      const res = await fetch(`${API}/api/memories?${p}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch { setItems([]); showToast('Não foi possível carregar as memórias.'); }
  }
  async function loadConfig() {
    try {
      const res = await fetch(`${API}/api/memory-config`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data.memory_enabled !== 'undefined') setConfig(data);
    } catch {}
  }
  async function saveConfig(partial) {
    try {
      const res = await fetch(`${API}/api/memory-config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial) });
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data.memory_enabled !== 'undefined') setConfig(data);
    } catch {}
  }

  async function add() {
    const content = newContent.trim();
    if (!content) return;
    setNewContent('');
    try {
      const res = await fetch(`${API}/api/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, scope: newScope, type: 'manual' }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '');
      await load();
    } catch (e) { showToast(e.message || 'Não foi possível salvar.'); }
  }

  async function patch(id, fields) {
    try { await fetch(`${API}/api/memories/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }); await load(); }
    catch { showToast('Não foi possível atualizar a memória.'); }
  }
  async function edit(m) {
    const content = prompt('Editar memória:', m.content);
    if (content === null || !content.trim() || content === m.content) return;
    await patch(m.id, { content: content.trim() });
  }
  async function remove(id) {
    if (!confirm('Apagar esta memória?')) return;
    try { await fetch(`${API}/api/memories/${id}`, { method: 'DELETE' }); await load(); } catch {}
  }
  async function removeAll() {
    if (!confirm('Apagar TODA a memória (fatos, preferências, índice de conversas)? Esta ação não pode ser desfeita. Dica: exporte antes.')) return;
    try { await fetch(`${API}/api/memories`, { method: 'DELETE' }); await load(); showToast('Memória apagada.', 'ok'); } catch {}
  }
  async function reindex() {
    setWorkingLabel('Reprocessando embeddings...');
    try {
      const r = await (await fetch(`${API}/api/memories/reindex`, { method: 'POST' })).json();
      showToast(r.degraded ? 'Reprocessado em modo texto (embeddings indisponíveis).' : `Reprocessadas ${r.reindexed} entradas.`, 'ok');
    } catch { showToast('Falha ao reprocessar.'); }
    finally { setWorkingLabel(''); }
  }
  async function importFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setWorkingLabel(`Importando "${f.name}"... (pode demorar alguns minutos)`);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch(`${API}/api/memories/import`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '');
      showToast(`Importado: ${data.conversations} conversa(s), ${data.chunks} trechos indexados, ${data.facts} fatos aprendidos.`, 'ok');
      await load();
    } catch (err) { showToast(err.message || 'Importação falhou.'); }
    finally { setWorkingLabel(''); e.target.value = ''; }
  }

  const scopeName = (scope) => {
    if (scope === 'global') return '🌐 Global';
    if (scope?.startsWith('client:')) { const c = clients.find(x => `client:${x.id}` === scope); return `👤 ${c?.name || 'Cliente'}`; }
    const a = assistants.find(x => x.id === scope);
    return a ? `${a.emoji || '🤖'} ${a.name}` : scope;
  };

  return <Modal title="Cérebro do Assistente" icon={<Brain size={18}/>} onClose={onClose}>
    <p className="muted" style={{ margin: 0 }}>Tudo o que o app sabe sobre você — aprendido das conversas, adicionado por você ou importado. Ele consulta isso automaticamente antes de responder.</p>

    <div className="memToolbar">
      <div className="memSearch"><Search size={14}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar na memória (por significado)..."/></div>
      <div className="memTypes">{TYPES.map(t => <button key={t.key} className={type === t.key ? 'on' : ''} onClick={() => setType(t.key)}>{t.label}</button>)}</div>
    </div>

    <div className="memAdd">
      <input value={newContent} onChange={e => setNewContent(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="Adicionar memória manual (ex.: Meu nome é Frederico, sou contador, CRC TO-006157/O-8)"/>
      <select value={newScope} onChange={e => setNewScope(e.target.value)} title="Escopo">
        <option value="global">🌐 Global</option>
        {clientId && <option value={`client:${clientId}`}>👤 Cliente atual</option>}
        {assistants.map(a => <option key={a.id} value={a.id}>{a.emoji || '🤖'} {a.name}</option>)}
      </select>
      <button className="primary" onClick={add}>Salvar</button>
    </div>

    <div className="memBtns">
      <button onClick={() => window.open(`${API}/api/memories/export`, '_blank')} title="Baixa um JSON com todas as memórias"><Download size={14}/> Exportar</button>
      <button onClick={() => fileRef.current?.click()} title="Importa .json (Claude/ChatGPT), .txt, .md ou .html"><Upload size={14}/> Importar conversas</button>
      <input ref={fileRef} type="file" accept=".json,.txt,.md,.html,.htm" style={{ display: 'none' }} onChange={importFile}/>
      <button onClick={reindex} title="Regera os embeddings de tudo"><RefreshCw size={14}/> Reprocessar</button>
      <button onClick={() => setConfigOpen(o => !o)}><Settings2 size={14}/> Configurações</button>
      <button className="danger" onClick={removeAll}><Trash2 size={14}/> Apagar tudo</button>
    </div>

    {workingLabel && <div className="working"><span className="spin"/><span>{workingLabel}</span></div>}

    {configOpen && config && <div className="memConfig">
      <label className="chk"><input type="checkbox" checked={!!config.memory_enabled} onChange={e => saveConfig({ memory_enabled: e.target.checked ? 1 : 0 })}/> Memória ativada (o app consulta o passado antes de responder)</label>
      <label className="chk"><input type="checkbox" checked={!!config.auto_memory} onChange={e => saveConfig({ auto_memory: e.target.checked ? 1 : 0 })}/> Memória automática (aprender fatos das conversas)</label>
      <div className="cfgRow"><span>Alvo de contexto (tokens) — suba para modelos de 1M</span><input type="number" min="4000" step="10000" value={config.context_target_tokens} onChange={e => saveConfig({ context_target_tokens: e.target.value })}/></div>
      <div className="cfgRow"><span>Memórias recuperadas por resposta</span><input type="number" min="0" max="50" value={config.max_memories} onChange={e => saveConfig({ max_memories: e.target.value })}/></div>
      <div className="cfgRow"><span>Trechos de conversas antigas por resposta</span><input type="number" min="0" max="50" value={config.max_chunks} onChange={e => saveConfig({ max_chunks: e.target.value })}/></div>
      <div className="cfgRow"><span>Importância mínima para salvar automático (1–5)</span><input type="number" min="1" max="5" value={config.importance_threshold} onChange={e => saveConfig({ importance_threshold: e.target.value })}/></div>
    </div>}

    <div className="memList">
      {items === null && <div className="working"><span className="spin"/><span>Carregando...</span></div>}
      {items?.length === 0 && <p className="muted">Nenhuma memória {query || type ? 'encontrada com esse filtro' : 'ainda — converse com o app ou adicione acima'}.</p>}
      {items?.map(m => (
        <div className={`memItem2 ${m.pinned ? 'pinned' : ''}`} key={m.id}>
          <div className="memItemTop">
            <span className="memBadge">{TYPE_BADGE[m.type] || m.type}</span>
            <span className="memScope">{scopeName(m.scope)}</span>
            <span className="memOrigin">{SOURCE_LABEL[m.source_type] || m.source_type} · {(m.updated_at || m.created_at || '').slice(0, 10)} · imp. {m.importance}/5</span>
            <span className="memItemBtns">
              <button onClick={() => patch(m.id, { pinned: m.pinned ? 0 : 1 })} title={m.pinned ? 'Desafixar' : 'Fixar (sempre no contexto)'}>{m.pinned ? <PinOff size={14}/> : <Pin size={14}/>}</button>
              <button onClick={() => edit(m)} title="Editar"><Pencil size={14}/></button>
              <button className="memDelBtn" onClick={() => remove(m.id)} title="Apagar"><X size={14}/></button>
            </span>
          </div>
          <div className="memContent">{m.content}</div>
        </div>
      ))}
    </div>
  </Modal>;
}
