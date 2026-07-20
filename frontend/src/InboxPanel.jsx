import React, { useEffect, useState } from 'react';
import { Inbox, X, Upload, FileText, FolderInput } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';

// Caixa de entrada de documentos por cliente: acumule arquivos e, com 1 clique,
// abra uma conversa nova já com tudo anexado para a IA processar.
export function InboxPanel({ clients = [], clientId = '', showToast, onOpenConversation, onClose, askConfirm }) {
  const [client, setClient] = useState(clientId || 'geral');
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, [client]);
  async function load() {
    setItems(null);
    try { const d = await (await fetch(`${API}/api/inbox/${client}`)).json(); setItems(Array.isArray(d) ? d : []); }
    catch { setItems([]); }
  }
  async function upload(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      const res = await fetch(`${API}/api/inbox/${client}/upload`, { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '');
      if (d.rejected?.length) {
        showToast(`🛡️ Antivírus: ${d.rejected.length} documento(s) recusado(s) por conter ameaça: ${d.rejected.map(r => r.name).join(', ')}`);
      } else {
        showToast(`${files.length} documento(s) recebido(s)${d.scanned ? ' e verificado(s) pelo antivírus ✓' : ''}.`, 'ok');
      }
      load();
    } catch (e) { showToast(e?.message || 'Falha ao enviar os documentos.'); }
    finally { setBusy(false); }
  }
  async function remove(stored) {
    if (!await askConfirm({ title: 'Remover documento?', message: 'Ele sairá desta caixa de entrada.', confirmLabel: 'Remover', destructive: true })) return;
    try { await fetch(`${API}/api/inbox/${client}/${encodeURIComponent(stored)}`, { method: 'DELETE' }); load(); } catch {}
  }
  async function analyze() {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/inbox/${client}/to-conversation`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '');
      onOpenConversation?.(d.id);
      onClose?.();
    } catch (e) { showToast(e.message || 'Não foi possível abrir os documentos.'); }
    finally { setBusy(false); }
  }

  const clientName = client === 'geral' ? 'Geral' : (clients.find(c => c.id === client)?.name || 'Cliente');

  return <Drawer title="Caixa de entrada de documentos" icon={<Inbox size={18}/>} onClose={onClose} className="inboxDrawer">
    <p className="drawerIntro">Guarde documentos por cliente e abra tudo em uma conversa nova quando for a hora de a IA ler, organizar e resumir.</p>

    <label>Cliente
      <select value={client} onChange={e => setClient(e.target.value)}>
        <option value="geral">🗂️ Geral</option>
        {clients.map(c => <option key={c.id} value={c.id}>👤 {c.name}</option>)}
      </select>
    </label>

    <label className="inboxDrop">
      <Upload size={20}/>
      <span>{busy ? 'Enviando...' : `Adicionar documentos à caixa de ${clientName}`}</span>
      <input type="file" multiple onChange={upload} disabled={busy}/>
    </label>

    <div className="memList">
      {items === null && <div className="working"><span className="spin"/><span>Carregando...</span></div>}
      {items?.length === 0 && <p className="muted">Nenhum documento na caixa ainda.</p>}
      {items?.map(f => (
        <div className="pcItem" key={f.stored}>
          <div className="pcInfo"><b><FileText size={13}/> {f.name}</b><code>{Math.ceil((f.size || 0) / 1024)} KB</code></div>
          <button className="memDelBtn" onClick={() => remove(f.stored)} title="Remover"><X size={15}/></button>
        </div>
      ))}
    </div>

    {items?.length > 0 && <button className="primary" onClick={analyze} disabled={busy}><FolderInput size={16}/> Abrir {items.length} documento(s) em nova conversa</button>}
  </Drawer>;
}
