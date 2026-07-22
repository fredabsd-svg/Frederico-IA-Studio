import React, { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Check, X, RefreshCw, Sparkles, Wand2, Plus, Trash2, Pencil, ExternalLink, CreditCard, Activity, AlertTriangle, Clock3, ShieldCheck } from 'lucide-react';
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
  const [billingUrl, setBillingUrl] = useState('');
  const [editingId, setEditingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState(null);
  const presets = useMemo(() => [...KEY_PROVIDERS, CUSTOM], []);
  const autoSynced = useRef(new Set());

  useEffect(() => { load(); }, []);
  useEffect(() => {
    for (const provider of providers || []) {
      if (provider.syncDue && !autoSynced.current.has(provider.id)) {
        autoSynced.current.add(provider.id);
        refreshProvider(provider, true);
      }
    }
  }, [providers]);

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
    setBillingUrl('');
  }

  async function saveProvider() {
    if (!editingId && !apiKey.trim()) { showToast('Informe a chave de API.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/providers${editingId ? `/${editingId}` : ''}`, {
        method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerType, name: name.trim(), apiKey: apiKey.trim(), base_url: baseUrl.trim(), model: model.trim(), billing_url: billingUrl.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'A chave não foi aceita.');
      setApiKey(''); setFormOpen(false); setEditingId('');
      showToast(`${data.imported || 0} modelo(s) sincronizado(s) do ${name}.`, 'ok');
      await load(); onProvidersChange?.();
    } catch (error) { showToast(error.message || 'Não foi possível adicionar o provedor.'); }
    finally { setBusy(false); }
  }

  async function refreshProvider(provider, automatic = false) {
    setActiveId(provider.id);
    try {
      const res = await fetch(`${API}/api/providers/${provider.id}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ automatic }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível atualizar.');
      if (!automatic) showToast(`${data.imported || 0} modelo(s) atualizado(s) do ${provider.name}.`, 'ok');
      await load(); onProvidersChange?.();
    } catch (error) { if (!automatic) showToast(error.message || 'Não foi possível atualizar os modelos.'); }
    finally { setActiveId(''); }
  }

  // Atualização MANUAL de todo o catálogo, com relatório por provedor
  // (adicionados, atualizados, removidos, itens a revisar, erros).
  async function syncAll() {
    setSyncing(true); setSyncReport(null);
    try {
      const res = await fetch(`${API}/api/models/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao atualizar o catálogo.');
      setSyncReport(data);
      const t = data.totals || {};
      showToast(`Catálogo atualizado: ${t.added || 0} novo(s), ${t.changed || 0} alterado(s), ${t.removed || 0} removido(s)${t.errors ? `, ${t.errors} erro(s)` : ''}.`, t.errors ? '' : 'ok');
      await load(); onProvidersChange?.();
    } catch (error) { showToast(error.message || 'Não foi possível atualizar o catálogo.'); }
    finally { setSyncing(false); }
  }

  function editProvider(provider) {
    setEditingId(provider.id);
    setProviderType(provider.providerType);
    setName(provider.name);
    setApiKey('');
    setBaseUrl(provider.base_url);
    setModel(provider.defaultModel || '');
    setBillingUrl(provider.billingURL || '');
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false); setEditingId(''); setApiKey(''); setBillingUrl('');
  }

  const dateLabel = value => value ? new Date(value).toLocaleString('pt-BR') : 'ainda não sincronizado';
  const moneyLabel = (value, currency = 'USD') => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: currency || 'USD' });

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

    {providers?.length > 0 && <div className="providerSyncBar">
      <button className="primary" onClick={syncAll} disabled={syncing}>
        {syncing ? <><span className="spin"/> Atualizando modelos...</> : <><RefreshCw size={14}/> Atualizar todos os modelos</>}
      </button>
      <small>Verifica modelos novos, removidos, mudança de preço, contexto, capacidades e status em todos os provedores. Também roda sozinho 1x/dia.</small>
    </div>}

    {syncReport && <div className="syncReport" aria-live="polite">
      {(syncReport.providers || []).map((p, i) => <div key={i} className={'syncRow ' + (p.ok ? 'ok' : 'err')}>
        <b>{p.provider}</b>
        {p.ok
          ? <span>{p.total} modelo(s) · {p.counts?.added || 0} novo(s), {p.counts?.changed || 0} atualizado(s), {p.counts?.removed || 0} removido(s){p.counts?.incomplete ? `, ${p.counts.incomplete} a revisar` : ''}{p.counts?.deprecated ? `, ${p.counts.deprecated} descontinuado(s)` : ''}</span>
          : <span className="err"><AlertTriangle size={12}/> {p.error}</span>}
      </div>)}
    </div>}

    <div className="providerList">
      {(providers || []).map(provider => <article className="providerCard" key={provider.id}>
        <div className="providerCardHead">
          <div className="providerIdentity"><span className="providerLogo">{provider.name.slice(0, 2).toUpperCase()}</span><div><b>{provider.name}</b><small>{provider.providerType}</small></div></div>
          <span className={`providerStatus ${provider.syncStatus === 'error' ? 'error' : 'ok'}`}>{provider.syncStatus === 'error' ? <AlertTriangle size={13}/> : <ShieldCheck size={13}/>} {provider.syncStatus === 'error' ? 'Atenção' : 'Chave validada'}</span>
        </div>
        <div className="providerMetrics">
          <div><span>Modelos</span><b>{provider.modelCount}</b></div>
          <div><span>Uso interno</span><b>{(provider.usage?.tokens || 0).toLocaleString('pt-BR')} tokens</b></div>
          <div><span>Custo estimado*</span><b>{provider.usage?.pricedMessages ? moneyLabel(provider.usage.estimatedCost) : 'Não informado'}</b></div>
          <div><span>Saldo oficial</span><b>{provider.officialBalance?.available && provider.officialBalance?.balance != null ? moneyLabel(provider.officialBalance.balance, provider.officialBalance.currency) : 'Indisponível'}</b></div>
        </div>
        <div className="providerDetails">
          <span><KeyRound size={13}/><code>{provider.keyMask}</code> · validade não informada pelo provedor</span>
          <span><Clock3 size={13}/>Sincronização: {dateLabel(provider.lastValidatedAt)}</span>
          {provider.syncError && <span className="providerError"><AlertTriangle size={13}/>{provider.syncError}</span>}
          {!provider.officialBalance?.available && <span>Este provedor não disponibiliza saldo por API para esta chave. Consulte o painel oficial.</span>}
          <span>* Estimativa interna pelo preço atual do catálogo; não é saldo nem fatura oficial.</span>
        </div>
        <div className="providerCardActions">
          <button onClick={() => refreshProvider(provider)} disabled={activeId === provider.id} title="Sincronizar modelos e saldo"><RefreshCw size={14}/> Sincronizar</button>
          <button onClick={() => editProvider(provider)} disabled={activeId === provider.id}><Pencil size={14}/> Editar</button>
          {provider.dashboardURL && <a href={provider.dashboardURL} target="_blank" rel="noreferrer"><Activity size={14}/> Painel <ExternalLink size={11}/></a>}
          {provider.billingURL && <a href={provider.billingURL} target="_blank" rel="noreferrer"><CreditCard size={14}/> Cobrança <ExternalLink size={11}/></a>}
          <button className="danger" onClick={() => removeProvider(provider)} disabled={activeId === provider.id} title="Remover provedor"><Trash2 size={14}/></button>
        </div>
      </article>)}
    </div>

    {!formOpen && <button className="primary providerAdd" onClick={() => { setEditingId(''); setFormOpen(true); }}><Plus size={15}/> Adicionar provedor</button>}

    {formOpen && <div className="providerForm">
      <div className="providerFormTitle">{editingId ? 'Editar provedor' : 'Novo provedor'}</div>
      <label>Provedor
        <select value={providerType} onChange={event => chooseType(event.target.value)} disabled={Boolean(editingId)}>
          {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>Nome para identificar
        <input value={name} onChange={event => setName(event.target.value)} placeholder="Ex.: NVIDIA trabalho"/>
      </label>
      <label>Chave de API
        <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={editingId ? 'Deixe em branco para manter a chave atual' : 'Cole a chave do provedor'} autoComplete="off"/>
      </label>
      <label>URL base
        <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://.../v1" autoComplete="off"/>
      </label>
      {providerType === 'alibaba' && <div className="pcHint">No Alibaba, use o campo <code>openAiCompatible</code> do CSV baixado junto com a chave. O endpoint varia por workspace e região.</div>}
      <label>Modelo para validação <span className="muted">(usado somente se o provedor não listar modelos)</span>
        <input value={model} onChange={event => setModel(event.target.value)} placeholder="Ex.: qwen3.7-plus" autoComplete="off"/>
      </label>
      <label>Link de cobrança <span className="muted">(opcional)</span>
        <input value={billingUrl} onChange={event => setBillingUrl(event.target.value)} placeholder="Painel de saldo/cobrança do provedor" autoComplete="off"/>
      </label>
      <div className="modalActions">
        <button onClick={closeForm} disabled={busy}>Cancelar</button>
        <div className="spacer"/>
        <button className="primary" onClick={saveProvider} disabled={busy}>{busy ? <><span className="spin sm"/> Validando...</> : editingId ? 'Salvar e sincronizar' : 'Validar e importar modelos'}</button>
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
