import React, { useEffect, useState } from 'react';
import { FolderCog, X, Lock, Unlock } from 'lucide-react';
import { API } from './constants.js';
import { Modal } from './components.jsx';

// "Pastas do Computador": libera pastas reais do PC para o assistente acessar
export function PcFoldersPanel({ showToast, onClose }) {
  const [items, setItems] = useState(null);
  const [label, setLabel] = useState('');
  const [pathv, setPathv] = useState('');
  const [writable, setWritable] = useState(true);

  useEffect(() => { load(); }, []);
  async function load() {
    try {
      const res = await fetch(`${API}/api/pc-folders`);
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch { setItems([]); }
  }
  async function add() {
    if (!label.trim() || !pathv.trim()) { showToast('Preencha o nome e o caminho da pasta.'); return; }
    try {
      const res = await fetch(`${API}/api/pc-folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: label.trim(), host_path: pathv.trim(), writable }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '');
      setLabel(''); setPathv(''); setWritable(true);
      showToast('Pasta liberada. Vale nas próximas mensagens (o sandbox foi reiniciado).', 'ok');
      load();
    } catch (e) { showToast(e.message || 'Não foi possível liberar a pasta.'); }
  }
  async function toggleWritable(f) {
    try { await fetch(`${API}/api/pc-folders/${f.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writable: f.writable ? 0 : 1 }) }); load(); } catch {}
  }
  async function remove(id) {
    if (!confirm('Remover o acesso a esta pasta? (Os arquivos não são apagados — o assistente apenas deixa de enxergá-los.)')) return;
    try { await fetch(`${API}/api/pc-folders/${id}`, { method: 'DELETE' }); load(); } catch {}
  }

  return <Modal title="Pastas do Computador" icon={<FolderCog size={18}/>} onClose={onClose}>
    <p className="muted" style={{ margin: 0 }}>Libere pastas específicas do seu PC para o assistente <b>procurar, ler e organizar</b> arquivos reais. Ele só enxerga o que você liberar aqui.</p>
    <div className="pcWarn">⚠️ Em pastas com <b>escrita</b>, o assistente pode mover/renomear arquivos reais e pode errar. Comece pelo essencial, prefira <b>só leitura</b> quando tiver dúvida, e mantenha backup do que for importante.</div>

    <label>Nome (como você chama a pasta)
      <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Ex.: Clientes"/>
    </label>
    <label>Caminho completo no computador
      <input value={pathv} onChange={e => setPathv(e.target.value)} placeholder="Ex.: C:\Users\conta\Documentos\Clientes"/>
    </label>
    <label className="chk"><input type="checkbox" checked={writable} onChange={e => setWritable(e.target.checked)}/> Permitir organizar (escrita) — desmarque para <b>só leitura</b></label>
    <button className="primary" onClick={add}>Liberar pasta</button>

    <div className="pcHint">💡 Como achar o caminho no Windows: abra a pasta no Explorer, clique na <b>barra de endereço</b> e copie o texto (ex.: <code>C:\Users\conta\Downloads</code>).</div>

    <div className="memList">
      {items === null && <div className="working"><span className="spin"/><span>Carregando...</span></div>}
      {items?.length === 0 && <p className="muted">Nenhuma pasta liberada ainda.</p>}
      {items?.map(f => (
        <div className="pcItem" key={f.id}>
          <div className="pcInfo">
            <b>{f.label}</b>
            <code>{f.host_path}</code>
          </div>
          <button className={`pcPerm ${f.writable ? 'rw' : 'ro'}`} onClick={() => toggleWritable(f)} title="Alternar entre só leitura e leitura+escrita">
            {f.writable ? <><Unlock size={13}/> Escrita</> : <><Lock size={13}/> Leitura</>}
          </button>
          <button className="memDelBtn" onClick={() => remove(f.id)} title="Remover acesso"><X size={15}/></button>
        </div>
      ))}
    </div>
  </Modal>;
}
