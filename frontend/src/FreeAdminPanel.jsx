// Painel administrativo do MODO GRATUITO (somente ADMIN_EMAIL): usuários
// ativos, consumo por usuário/modelo/dia, erros, bloqueios por abuso e
// configurações globais (liga/desliga, limite diário, modelos habilitados).
import React, { useEffect, useState } from 'react';
import { Gauge, RefreshCw, Ban, Check, X } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';

const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
const prettyModel = (id) => String(id || '').replace(/:free$/, '');

export function FreeAdminPanel({ showToast, askConfirm, askPrompt, onClose }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [limitDraft, setLimitDraft] = useState('');

  useEffect(() => { load(); }, []);
  async function load() {
    setData(null);
    try {
      const res = await fetch(`${API}/api/admin/free-tier`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '');
      setData(d);
      setLimitDraft(String(d.config?.msgsPerDay ?? ''));
    } catch (e) { showToast(e.message || 'Não foi possível carregar o painel.'); setData({ error: true }); }
  }

  async function saveSettings(patch) {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/admin/free-tier/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || '');
      showToast('Configuração salva.', 'ok');
      load();
    } catch (e) { showToast(e.message || 'Não foi possível salvar.'); }
    finally { setBusy(false); }
  }

  async function toggleModel(id) {
    const disabled = data?.config?.disabledModels || [];
    const next = disabled.includes(id) ? disabled.filter(m => m !== id) : [...disabled, id];
    await saveSettings({ disabledModels: next });
  }

  async function blockUser(u) {
    const reason = await askPrompt({ title: `Bloquear ${u.email}?`, label: 'Motivo do bloqueio (fica registrado, visível só para você)', confirmLabel: 'Bloquear' });
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/admin/free-tier/block`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: u.id, reason })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '');
      showToast('Usuário bloqueado no modo gratuito.', 'ok');
      load();
    } catch (e) { showToast(e.message || 'Não foi possível bloquear.'); }
    finally { setBusy(false); }
  }

  async function unblockUser(userId) {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/admin/free-tier/block/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      showToast('Usuário desbloqueado.', 'ok');
      load();
    } catch { showToast('Não foi possível desbloquear.'); }
    finally { setBusy(false); }
  }

  async function editUserLimit(u) {
    const value = await askPrompt({
      title: `Limite individual de ${u.email}`,
      label: 'Mensagens por dia SÓ para este usuário (vazio = limite global)',
      initialValue: u.limite_individual ? String(u.limite_individual) : ''
    });
    if (value === null) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/admin/free-tier/user-limit`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.id, msgsPerDay: value.trim() === '' ? null : Number(value) })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '');
      showToast('Limite atualizado.', 'ok');
      load();
    } catch (e) { showToast(e.message || 'Não foi possível salvar o limite.'); }
    finally { setBusy(false); }
  }

  const cfg = data?.config;
  return <Drawer title="Modo gratuito — painel do administrador" icon={<Gauge size={18}/>} onClose={onClose} className="freeAdminDrawer">
    {!data && <div className="working"><span className="spin"/><span>Carregando...</span></div>}
    {data?.error && <div className="pcWarn">Não foi possível carregar o painel. Confira se você é o administrador (ADMIN_EMAIL).</div>}
    {data && !data.error && <>
      <div className="statRow">
        <div className="stat"><b>{fmt(data.totals?.usuariosAtivos)}</b><span>usuários ativos no gratuito</span></div>
        <div className="stat"><b>{fmt(data.totals?.requisicoes30d)}</b><span>requisições (30 dias)</span></div>
        <div className="stat"><b>{fmt(data.totals?.tokens30d)}</b><span>tokens (30 dias)</span></div>
        <div className="stat"><b>{fmt(data.totals?.erros30d)}</b><span>erros (30 dias)</span></div>
      </div>

      <div className="field">
        <span className="fieldLabel">Configurações globais</span>
        <div className="freeInfoRows">
          <div><span>Provedor</span><b>{cfg?.provider} · <code>{cfg?.baseURL}</code></b></div>
          <div><span>Fila agora</span><b>{fmt(data.queue?.waiting)} esperando · {fmt(data.queue?.running)}/{fmt(data.queue?.concurrency)} processando</b></div>
        </div>
        <div className="modalActions" style={{ marginTop: 8 }}>
          <button onClick={() => saveSettings({ enabled: !cfg?.enabled })} disabled={busy}>
            {cfg?.enabled ? <><Ban size={15}/> Desativar modo gratuito</> : <><Check size={15}/> Ativar modo gratuito</>}
          </button>
          <div className="spacer"/>
          <label className="freeLimitInline">Limite diário global
            <input value={limitDraft} onChange={e => setLimitDraft(e.target.value)} inputMode="numeric" style={{ width: 70 }}/>
          </label>
          <button className="primary" onClick={() => saveSettings({ msgsPerDay: Number(limitDraft) })} disabled={busy || !Number(limitDraft)}>Salvar limite</button>
        </div>
        {!cfg?.enabled && <div className="pcWarn">O modo gratuito está DESATIVADO — usuários sem chave própria verão a orientação para configurar uma chave.</div>}
      </div>

      <div className="field">
        <span className="fieldLabel">Modelos gratuitos (clique para ativar/desativar)</span>
        <div className="freeModelToggles">
          {(cfg?.allModels || []).map(id => {
            const off = (cfg?.disabledModels || []).includes(id);
            return <button key={id} className={`freeModelToggle ${off ? 'off' : ''}`} onClick={() => toggleModel(id)} disabled={busy} title={off ? 'Desativado — clique para ativar' : 'Ativo — clique para desativar'}>
              {off ? <X size={13}/> : <Check size={13}/>} {prettyModel(id)}
            </button>;
          })}
        </div>
      </div>

      <div className="field">
        <span className="fieldLabel">Usuários no modo gratuito</span>
        <table className="atable">
          <thead><tr><th>Usuário</th><th>Hoje</th><th>Total</th><th>Tokens</th><th>Limite</th><th></th></tr></thead>
          <tbody>
            {(data.users || []).map(u => <tr key={u.id} className={u.bloqueado ? 'freeRowBlocked' : ''}>
              <td title={u.name || ''}>{u.email}{u.bloqueado && <span className="badge danger" title={u.motivo_bloqueio || ''}>bloqueado</span>}</td>
              <td>{fmt(u.msgs_hoje)}</td>
              <td>{fmt(u.msgs_total)}</td>
              <td>{fmt(u.tokens_total)}</td>
              <td><button className="linkish" onClick={() => editUserLimit(u)} title="Editar limite individual">{u.limite_individual || 'global'}</button></td>
              <td>{u.bloqueado
                ? <button onClick={() => unblockUser(u.id)} disabled={busy}>Desbloquear</button>
                : <button className="danger" onClick={() => blockUser(u)} disabled={busy}>Bloquear</button>}</td>
            </tr>)}
            {(!data.users || !data.users.length) && <tr><td colSpan={6} className="muted">Ninguém aderiu ao modo gratuito ainda.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="field">
        <span className="fieldLabel">Consumo por modelo (30 dias)</span>
        <table className="atable">
          <thead><tr><th>Modelo</th><th>Requisições</th><th>Tokens</th><th>Falhas</th></tr></thead>
          <tbody>
            {(data.byModel || []).map((r, i) => <tr key={i}><td>{prettyModel(r.model) || '—'}</td><td>{fmt(r.requisicoes)}</td><td>{fmt(r.tokens)}</td><td>{fmt(r.falhas)}</td></tr>)}
            {(!data.byModel || !data.byModel.length) && <tr><td colSpan={4} className="muted">Sem dados ainda.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="field">
        <span className="fieldLabel">Por dia (14 dias)</span>
        <table className="atable">
          <thead><tr><th>Dia</th><th>Requisições</th><th>Tokens</th><th>Erros</th><th>Limitadas</th></tr></thead>
          <tbody>
            {(data.byDay || []).map((r, i) => <tr key={i}><td>{r.dia}</td><td>{fmt(r.requisicoes)}</td><td>{fmt(r.tokens)}</td><td>{fmt(r.erros)}</td><td>{fmt(r.limitadas)}</td></tr>)}
            {(!data.byDay || !data.byDay.length) && <tr><td colSpan={5} className="muted">Sem dados ainda.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="field">
        <span className="fieldLabel">Últimos erros e indisponibilidades</span>
        <div className="memList freeErrorList">
          {(data.errors || []).map((e, i) => <div key={i} className="freeErrorItem">
            <span className="muted small">{String(e.created_at || '').slice(0, 16).replace('T', ' ')}</span>
            <b>{e.status}</b> · {prettyModel(e.model) || '—'} · {e.email || '—'}
            {e.detail && <div className="muted small">{e.detail}</div>}
          </div>)}
          {(!data.errors || !data.errors.length) && <p className="muted">Nenhum erro registrado. 🎉</p>}
        </div>
      </div>

      <div className="modalActions">
        <button onClick={load} disabled={busy}><RefreshCw size={15}/> Atualizar</button>
        <div className="spacer"/>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Custos: os modelos listados são gratuitos no provedor — o consumo em tokens acima é o melhor
        indicador de volume. Se você trocar FREE_TIER_MODELS por modelos pagos, o custo aparecerá na
        fatura do provedor da plataforma.
      </p>
    </>}
  </Drawer>;
}
