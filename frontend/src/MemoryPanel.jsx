import React, { useEffect, useRef, useState } from 'react';
import { Brain, Search, Pin, PinOff, Pencil, X, Download, Upload, RefreshCw, Trash2, Check } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';

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
export function MemoryPanel({ assistants, clients, clientId, showToast, onClose, askConfirm, askPrompt }) {
  const [items, setItems] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newScope, setNewScope] = useState('global');
  const [importScope, setImportScope] = useState(() => clientId ? `client:${clientId}` : 'global');
  const [config, setConfig] = useState(null);
  const [activeTab, setActiveTab] = useState('memories');
  const [workingLabel, setWorkingLabel] = useState('');
  const fileRef = useRef(null);
  const searchTimer = useRef(null);
  const importTimer = useRef(null);

  useEffect(() => {
    load();
    loadSuggestions();
    loadConfig();
    // Se já houver uma importação rodando (painel reaberto), retoma o acompanhamento
    fetch(`${API}/api/memories/import-status`).then(r => r.json()).then(s => { if (s.running) watchImport(); }).catch(() => {});
    return () => { clearInterval(importTimer.current); clearTimeout(searchTimer.current); };
  }, []);
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
  async function loadSuggestions() {
    try {
      const res = await fetch(`${API}/api/memory-suggestions`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSuggestions(Array.isArray(data) ? data : []);
    } catch { setSuggestions([]); }
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
  async function approveSuggestion(s) {
    try {
      const res = await fetch(`${API}/api/memory-suggestions/${s.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: s.content, type: s.type, scope: s.scope, importance: s.importance }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '');
      showToast('Memoria aprovada.', 'ok');
      await loadSuggestions();
      await load();
    } catch (e) { showToast(e.message || 'Nao foi possivel aprovar.'); }
  }
  async function editSuggestion(s) {
    const content = await askPrompt({ title: 'Editar sugestão', label: 'Conteúdo da sugestão', initialValue: s.content, confirmLabel: 'Salvar' });
    if (content === null || !content.trim() || content === s.content) return;
    try {
      const res = await fetch(`${API}/api/memory-suggestions/${s.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content.trim() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '');
      await loadSuggestions();
    } catch (e) { showToast(e.message || 'Nao foi possivel editar a sugestao.'); }
  }
  async function rejectSuggestion(id) {
    if (!await askConfirm({ title: 'Descartar sugestão?', message: 'Ela não será adicionada à memória do assistente.', confirmLabel: 'Descartar', destructive: true })) return;
    try { await fetch(`${API}/api/memory-suggestions/${id}/reject`, { method: 'POST' }); await loadSuggestions(); }
    catch { showToast('Nao foi possivel descartar a sugestao.'); }
  }
  async function edit(m) {
    const content = await askPrompt({ title: 'Editar memória', label: 'Conteúdo da memória', initialValue: m.content, confirmLabel: 'Salvar' });
    if (content === null || !content.trim() || content === m.content) return;
    await patch(m.id, { content: content.trim() });
  }
  async function remove(id) {
    if (!await askConfirm({ title: 'Apagar memória?', message: 'Essa informação deixará de ser usada nas próximas respostas.', confirmLabel: 'Apagar', destructive: true })) return;
    try { await fetch(`${API}/api/memories/${id}`, { method: 'DELETE' }); await load(); } catch {}
  }
  async function removeAll() {
    if (!await askConfirm({ title: 'Apagar toda a memória?', message: 'Fatos, preferências e índices de conversas serão removidos. Exporte uma cópia antes, pois esta ação não pode ser desfeita.', confirmLabel: 'Apagar tudo', destructive: true })) return;
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
  function watchImport() {
    clearInterval(importTimer.current);
    importTimer.current = setInterval(async () => {
      try {
        const s = await (await fetch(`${API}/api/memories/import-status`)).json();
        if (s.running) {
          setWorkingLabel(`Importando "${s.file}": conversa ${s.processed} de ${s.total} · ${s.chunks} trechos · ${s.facts} fatos aprendidos...`);
          return;
        }
        clearInterval(importTimer.current);
        setWorkingLabel('');
        if (s.done) {
          if (s.error) showToast(`Importação falhou: ${s.error}`);
          else showToast(`✅ Importado: ${s.total} conversa(s), ${s.chunks} trechos indexados, ${s.facts} fatos aprendidos.`, 'ok');
          await loadSuggestions();
          await load();
        }
      } catch {}
    }, 2500);
  }

  async function importFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setWorkingLabel(`Enviando "${f.name}"...`);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch(`${API}/api/memories/import?scope=${encodeURIComponent(importScope || 'global')}`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '');
      watchImport(); // acompanha o progresso em segundo plano
    } catch (err) { setWorkingLabel(''); showToast(err.message || 'Importação falhou.'); }
    finally { e.target.value = ''; }
  }

  const scopeName = (scope) => {
    if (scope === 'office') return 'Escritorio';
    if (scope === 'global') return '🌐 Global';
    if (scope?.startsWith('client:')) { const c = clients.find(x => `client:${x.id}` === scope); return `👤 ${c?.name || 'Cliente'}`; }
    const a = assistants.find(x => x.id === scope);
    return a ? `${a.emoji || '🤖'} ${a.name}` : scope;
  };

  return <Drawer title="Memória" icon={<Brain size={18}/>} onClose={onClose} className="memoryDrawer">
    <p className="drawerIntro">Informações que o app pode usar nas próximas respostas. Separe o que é lembrado, revisado e importado sem perder o contexto da conversa.</p>

    <div className="memTabs" role="tablist" aria-label="Seções da memória">
      <button className={activeTab === 'memories' ? 'on' : ''} onClick={() => setActiveTab('memories')} role="tab" aria-selected={activeTab === 'memories'}>Memórias</button>
      <button className={activeTab === 'suggestions' ? 'on' : ''} onClick={() => setActiveTab('suggestions')} role="tab" aria-selected={activeTab === 'suggestions'}>Sugestões{suggestions.length > 0 && <span className="memTabBadge">{suggestions.length}</span>}</button>
      <button className={activeTab === 'import' ? 'on' : ''} onClick={() => setActiveTab('import')} role="tab" aria-selected={activeTab === 'import'}>Importar</button>
      <button className={activeTab === 'settings' ? 'on' : ''} onClick={() => setActiveTab('settings')} role="tab" aria-selected={activeTab === 'settings'}>Configurar</button>
    </div>

    {workingLabel && <div className="working"><span className="spin"/><span>{workingLabel}</span></div>}

    {activeTab === 'memories' && <div className="memPanelSection" role="tabpanel">
      <div className="memToolbar">
        <div className="memSearch"><Search size={14}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar na memória (por significado)..."/></div>
        <div className="memTypes">{TYPES.map(t => <button key={t.key} className={type === t.key ? 'on' : ''} onClick={() => setType(t.key)}>{t.label}</button>)}</div>
      </div>

      <div className="memAdd">
        <input value={newContent} onChange={e => setNewContent(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="Adicionar memória manual (ex.: Meu nome é Frederico, sou contador, CRC TO-006157/O-8)"/>
        <select value={newScope} onChange={e => setNewScope(e.target.value)} title="Escopo">
          <option value="global">🌐 Global</option>
          <option value="office">Escritorio</option>
          {clientId && <option value={`client:${clientId}`}>👤 Cliente atual</option>}
          {assistants.map(a => <option key={a.id} value={a.id}>{a.emoji || '🤖'} {a.name}</option>)}
        </select>
        <button className="primary" onClick={add}>Salvar</button>
      </div>

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
    </div>}

    {activeTab === 'suggestions' && <div className="memPanelSection" role="tabpanel">
      <div className="sectionLead"><b>Memórias sugeridas</b><span>Revise antes que informações aprendidas nas conversas entrem no contexto do assistente.</span></div>
      {suggestions.length === 0 && <p className="drawerEmpty">Não há sugestões pendentes agora.</p>}
      {suggestions.length > 0 && <div className="suggestBox">
        {suggestions.map(s => (
          <div className="suggestItem" key={s.id}>
            <div className="memItemTop">
              <span className="memBadge">{TYPE_BADGE[s.type] || s.type}</span>
              <span className="memScope">{scopeName(s.scope)}</span>
              <span className="memOrigin">{SOURCE_LABEL[s.source_type] || s.source_type} · imp. {s.importance}/5</span>
            </div>
            <div className="memContent">{s.content}</div>
            <div className="suggestActions">
              <button className="primary" onClick={() => approveSuggestion(s)}><Check size={14}/> Aprovar</button>
              <button onClick={() => editSuggestion(s)}><Pencil size={14}/> Editar</button>
              <button className="danger" onClick={() => rejectSuggestion(s.id)}><X size={14}/> Descartar</button>
            </div>
          </div>
        ))}
      </div>}
    </div>}

    {activeTab === 'import' && <div className="memPanelSection" role="tabpanel">
      <div className="sectionLead"><b>Importar e manter</b><span>Traga conversas antigas para a memória ou faça uma cópia antes de uma limpeza completa.</span></div>
      <div className="memBtns memImportActions">
        <button onClick={() => window.open(`${API}/api/memories/export`, '_blank')} title="Baixa um JSON com todas as memórias"><Download size={14}/> Exportar memória</button>
        <select className="memScopePicker" value={importScope} onChange={e => setImportScope(e.target.value)} title="Escopo da importação">
          <option value="global">Importar para: Geral</option>
          <option value="office">Importar para: Escritorio</option>
          {clientId && <option value={`client:${clientId}`}>Importar para: Cliente atual</option>}
        </select>
        <button onClick={() => fileRef.current?.click()} title="Importa .json (Claude/ChatGPT), .txt, .md ou .html"><Upload size={14}/> Importar conversas</button>
        <input ref={fileRef} type="file" accept=".json,.txt,.md,.html,.htm" style={{ display: 'none' }} onChange={importFile}/>
        <button onClick={reindex} title="Regera os embeddings de tudo"><RefreshCw size={14}/> Reprocessar</button>
        <button className="danger" onClick={removeAll}><Trash2 size={14}/> Apagar toda a memória</button>
      </div>
    </div>}

    {activeTab === 'settings' && <div className="memPanelSection memConfig" role="tabpanel">
      {!config && <div className="working"><span className="spin"/><span>Carregando configurações...</span></div>}
      {config && <>
        <label className="chk"><input type="checkbox" checked={!!config.economy_mode} onChange={e => saveConfig({ economy_mode: e.target.checked ? 1 : 0 })}/> 💸 <b>Economia de tokens</b> — reduz o contexto enviado e as chamadas extras (mais barato; recomendado)</label>
        <div className="teamHint" style={{ padding: '0 2px 4px' }}>Ligado, o app envia bem menos "memória" e histórico em cada mensagem e resume as conversas com menos frequência. Desligue só se precisar que a IA lembre de muitos detalhes de conversas antigas.</div>
        <label className="chk"><input type="checkbox" checked={!!config.memory_enabled} onChange={e => saveConfig({ memory_enabled: e.target.checked ? 1 : 0 })}/> Memória ativada (o app consulta o passado antes de responder)</label>
        <label className="chk"><input type="checkbox" checked={!!config.auto_memory} onChange={e => saveConfig({ auto_memory: e.target.checked ? 1 : 0 })}/> Memória automática (aprender fatos das conversas)</label>
        <label className="chk"><input type="checkbox" checked={!!config.review_auto_memory} onChange={e => saveConfig({ review_auto_memory: e.target.checked ? 1 : 0 })}/> Revisar memórias aprendidas antes de salvar</label>
        <div className="cfgRow"><span>Limite máximo de contexto (o app reduz automaticamente por modelo)</span><input type="number" min="4000" step="10000" value={config.context_target_tokens} onChange={e => saveConfig({ context_target_tokens: Number(e.target.value) || 0 })}/></div>
        <div className="cfgRow"><span>Memórias recuperadas por resposta</span><input type="number" min="0" max="50" value={config.max_memories} onChange={e => saveConfig({ max_memories: Number(e.target.value) || 0 })}/></div>
        <div className="cfgRow"><span>Trechos de conversas antigas por resposta</span><input type="number" min="0" max="50" value={config.max_chunks} onChange={e => saveConfig({ max_chunks: Number(e.target.value) || 0 })}/></div>
        <div className="cfgRow"><span>Importância mínima para salvar automático (1–5)</span><input type="number" min="1" max="5" value={config.importance_threshold} onChange={e => saveConfig({ importance_threshold: Number(e.target.value) || 1 })}/></div>
      </>}
    </div>}
  </Drawer>;
}
