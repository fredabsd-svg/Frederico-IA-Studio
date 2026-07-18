import React, { useEffect, useState } from 'react';
import { KeyRound, Check, X, RefreshCw } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';

// Provedor de IA (BYOK): cada pessoa cadastra a própria chave de API. A chave
// fica criptografada no servidor e nunca é exibida por completo.
export function ProviderPanel({ showToast, onClose }) {
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);

  useEffect(() => { load(); }, []);
  async function load() {
    setStatus(null);
    try {
      const d = await (await fetch(`${API}/api/provider`)).json();
      setStatus(d || {});
      setBaseUrl(d?.base_url || '');
      setModel(d?.model || '');
    } catch { setStatus({}); }
  }

  async function runTest() {
    setTesting(true); setTest(null);
    try {
      const body = { base_url: baseUrl.trim(), model: model.trim() };
      if (apiKey) body.apiKey = apiKey;
      const res = await fetch(`${API}/api/provider/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok !== false) setTest({ ok: true });
      else setTest({ ok: false, error: d.error || 'A chave não foi aceita pelo provedor.' });
    } catch (e) { setTest({ ok: false, error: e.message || 'Não foi possível testar a chave.' }); }
    finally { setTesting(false); }
  }

  async function save() {
    setBusy(true);
    try {
      const body = { base_url: baseUrl.trim(), model: model.trim() };
      if (apiKey) body.apiKey = apiKey; // só envia se a pessoa digitou uma nova
      const res = await fetch(`${API}/api/provider`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '');
      setApiKey(''); setTest(null);
      showToast('Provedor de IA salvo.', 'ok');
      load();
    } catch (e) { showToast(e.message || 'Não foi possível salvar o provedor.'); }
    finally { setBusy(false); }
  }

  async function removeKey() {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/provider`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: '', base_url: baseUrl.trim(), model: model.trim() }) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || ''); }
      setApiKey(''); setTest(null);
      showToast('Chave removida.', 'ok');
      load();
    } catch (e) { showToast(e.message || 'Não foi possível remover a chave.'); }
    finally { setBusy(false); }
  }

  return <Drawer title="Provedor de IA" icon={<KeyRound size={18}/>} onClose={onClose} className="providerDrawer">
    <p className="drawerIntro">Cadastre a sua própria chave de API para conversar com a IA. Cada pessoa usa a sua chave, com o seu limite e a sua conta no provedor.</p>

    {status === null && <div className="working"><span className="spin"/><span>Carregando...</span></div>}

    {status && (status.hasKey
      ? <div className="pcHint" style={{ color: 'var(--text)' }}>
          <b style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Check size={14} style={{ color: 'var(--ok)' }}/> Chave configurada</b>
          <div className="muted small" style={{ marginTop: 4 }}>
            {status.keyMask && <code>{status.keyMask}</code>}
            {' · '}
            {status.source === 'user' ? 'chave própria' : 'chave do servidor'}
          </div>
        </div>
      : <div className="pcWarn">Nenhuma chave configurada. É preciso cadastrar uma chave de API abaixo para conseguir conversar com a IA.</div>
    )}

    <label>Chave de API
      <input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setTest(null); }} placeholder="sk-or-v1-..." autoComplete="off"/>
    </label>
    <p className="muted small" style={{ margin: '-8px 0 0' }}>Deixe em branco para manter a chave atual.</p>

    <label>URL base <span className="muted">(opcional)</span>
      <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" autoComplete="off"/>
    </label>
    <label>Modelo <span className="muted">(opcional)</span>
      <input value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek/deepseek-chat" autoComplete="off"/>
    </label>

    {test && (test.ok
      ? <div className="pcHint" style={{ color: 'var(--ok)' }}><Check size={14}/> Chave válida</div>
      : <div className="pcHint" style={{ color: 'var(--danger)' }}><X size={14}/> {test.error}</div>
    )}

    <div className="modalActions">
      <button onClick={runTest} disabled={testing || busy}>{testing ? <><span className="spin sm"/> Testando...</> : <><RefreshCw size={15}/> Testar</>}</button>
      <div className="spacer"/>
      {status?.hasKey && status?.source === 'user' && <button className="danger" onClick={removeKey} disabled={busy}>Remover chave</button>}
      <button className="primary" onClick={save} disabled={busy}>{busy ? 'Salvando...' : 'Salvar'}</button>
    </div>

    <div className="pcHint">🔒 Sua chave fica criptografada no servidor e nunca é exibida por completo. Pegue uma em <code>openrouter.ai</code>.</div>
  </Drawer>;
}
