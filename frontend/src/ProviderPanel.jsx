import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, Check, X, RefreshCw, Sparkles, Wand2, Plus, Trash2 } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';
import { KEY_PROVIDERS } from './KeyWizard.jsx';

const CUSTOM = { id: 'custom', name: 'Outro (OpenAI compatível)', base: '', modelExample: '' };

export function ProviderPanel({ showToast, freeStatus, onOpenWizard, onFreeChange, onProvidersChange, onClose }) {
  const [providers, setProviders] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [providerType, setProviderType] = useState('openrouter');
  const [name, setName] = useState('OpenRouter');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://openrouter.ai/api/v1');
  const [model, setModel] = useState('deepseek/deepseek-chat');
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState('');
  const presets = useMemo(() => [...KEY_PROVIDERS, CUSTOM], []);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const res = await fetch(`${API}/api/providers`);
      const data = await res.json();
      setProviders(Array.isArray(data.providers) ? data.providers : []);
    } catch { setProviders([]); }
  }

  function chooseType(id) {
    const preset = presets.find(item => item.id === id) || CUSTOM;
    setProviderType(preset.id);
    setName(preset.name.replace('Outro (OpenAI compatível)', 'Meu provedor'));
    setBaseUrl(preset.base || '');
    setModel(preset.modelExample || '');
  }

  async function addProvider() {
    if (!apiKey.trim()) { showToast('Informe a chave de API.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/providers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerType, name: name.trim(), apiKey: apiKey.trim(), base_url: baseUrl.trim(), model: model.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'A chave não foi aceita.');
      setApiKey(''); setFormOpen(false);
      showToast(`${data.imported || 0} modelo(s) importado(s) do ${name}.`, 'ok');
      await load(); onProvidersChange?.();
    } catch (error) { showToast(error.message || 'Não foi possível adicionar o provedor.'); }
    finally { setBusy(false); }
  }

  async function refreshProvider(provider) {
    setActiveId(provider.id);
    try {
      const res = await fetch(`${API}/api/providers/${provider.id}/refresh`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível atualizar.');
      showToast(`${data.imported || 0} modelo(s) atualizado(s) do ${provider.name}.`, 'ok');
      await load(); onProvidersChange?.();
    } catch (error) { showToast(error.message || 'Não foi possível atualizar os modelos.'); }
    finally { setActiveId(''); }
  }

  async function removeProvider(provider) {
    if (!window.confirm(`Remover a chave e os modelos de ${provider.name}?`)) return;
    setActiveId(provider.id);
    try {
      const res = await fetch(`${API}/api/providers/${provider.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Não foi possível remover.');
      showToast(`Provedor ${provider.name} removido.`, 'ok');
      await load(); onProvidersChange?.();
    } catch (error) { showToast(error.message || 'Não foi possível remover o provedor.'); }
    finally { setActiveId(''); }
  }

  return <Drawer title="Provedores de IA" icon={<KeyRound size={18}/>} onClose={onClose} className="providerDrawer">
    <p className="drawerIntro">Cada chave mantém seu próprio catálogo. Um modelo só aparece depois que a chave do respectivo provedor é validada.</p>

    {providers === null && <div className="working"><span className="spin"/><span>Carregando...</span></div>}
    {providers?.length === 0 && <div className="pcWarn">Nenhuma chave configurada. Nenhum modelo de IA será exibido até você adicionar e validar um provedor.</div>}

    <div className="providerList">
      {(providers || []).map(provider => <div className="providerCard" key={provider.id}>
        <div className="providerCardInfo">
          <b><Check size={14}/>{provider.name}</b>
          <span>{provider.modelCount} modelo(s) · <code>{provider.keyMask}</code></span>
          <small>{provider.base_url}</small>
        </div>
        <div className="providerCardActions">
          <button onClick={() => refreshProvider(provider)} disabled={activeId === provider.id} title="Validar novamente e atualizar modelos"><RefreshCw size={14}/></button>
          <button className="danger" onClick={() => removeProvider(provider)} disabled={activeId === provider.id} title="Remover provedor"><Trash2 size={14}/></button>
        </div>
      </div>)}
    </div>

    {!formOpen && <button className="primary providerAdd" onClick={() => setFormOpen(true)}><Plus size={15}/> Adicionar provedor</button>}

    {formOpen && <div className="providerForm">
      <label>Provedor
        <select value={providerType} onChange={event => chooseType(event.target.value)}>
          {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>Nome para identificar
        <input value={name} onChange={event => setName(event.target.value)} placeholder="Ex.: NVIDIA trabalho"/>
      </label>
      <label>Chave de API
        <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="Cole a chave do provedor" autoComplete="off"/>
      </label>
      <label>URL base
        <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://.../v1" autoComplete="off"/>
      </label>
      {providerType === 'alibaba' && <div className="pcHint">No Alibaba, use o campo <code>openAiCompatible</code> do CSV baixado junto com a chave. O endpoint varia por workspace e região.</div>}
      <label>Modelo para validação <span className="muted">(usado somente se o provedor não listar modelos)</span>
        <input value={model} onChange={event => setModel(event.target.value)} placeholder="Ex.: qwen3.7-plus" autoComplete="off"/>
      </label>
      <div className="modalActions">
        <button onClick={() => { setFormOpen(false); setApiKey(''); }} disabled={busy}>Cancelar</button>
        <div className="spacer"/>
        <button className="primary" onClick={addProvider} disabled={busy}>{busy ? <><span className="spin sm"/> Validando...</> : 'Validar e importar modelos'}</button>
      </div>
    </div>}

    {onOpenWizard && <button className="wizardEntry" onClick={onOpenWizard}>
      <Wand2 size={15}/> <b>Assistente passo a passo</b> — ajuda a obter uma nova chave
    </button>}

    {freeStatus?.configured && providers?.length === 0 && (
      freeStatus.active
        ? <button className="freeToggleBtn" disabled={busy} onClick={async () => {
            setBusy(true); try { await fetch(`${API}/api/free-tier/opt-in`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable: false }) }); showToast('Modo gratuito desativado.', 'ok'); onFreeChange?.(); onProvidersChange?.(); } finally { setBusy(false); }
          }}><X size={14}/> Sair do modo gratuito</button>
        : <button className="freeToggleBtn primaryish" disabled={busy || !freeStatus.enabled} onClick={async () => {
            setBusy(true); try { await fetch(`${API}/api/free-tier/opt-in`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enable: true }) }); showToast('Modo gratuito ativado!', 'ok'); onFreeChange?.(); onProvidersChange?.(); } finally { setBusy(false); }
          }}><Sparkles size={14}/> {freeStatus.enabled ? 'Começar gratuitamente' : 'Modo gratuito indisponível'}</button>
    )}

    <div className="pcHint">🔒 As chaves ficam criptografadas no servidor. O aplicativo nunca as devolve por completo.</div>
  </Drawer>;
}
