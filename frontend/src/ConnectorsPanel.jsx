import React, { useEffect, useState } from 'react';
import { Cable, Check, RefreshCw, X } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';

// Ícone do GitHub (SVG inline) — os ícones de marca saíram do lucide-react.
export function GitHubIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58C20.56 22.29 24 17.79 24 12.5 24 5.87 18.63.5 12 .5z"/>
    </svg>
  );
}

// Conectores de serviços externos. O primeiro é o GitHub: com a conta
// conectada, o assistente consegue clonar repositórios, fazer alterações e
// enviá-las de volta (push/Pull Request) — tudo pelo chat ou pelo modo
// desenvolvedor. O token fica criptografado no servidor e nunca é exibido.
export function ConnectorsPanel({ showToast, onClose }) {
  const [github, setGithub] = useState(null); // { connected, login, name }
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);

  useEffect(() => { load(); }, []);
  async function load() {
    setGithub(null);
    try {
      const list = await (await fetch(`${API}/api/connectors`)).json();
      setGithub((Array.isArray(list) ? list : []).find(c => c.provider === 'github') || { connected: false });
    } catch { setGithub({ connected: false }); }
  }

  async function runTest() {
    setTesting(true); setTest(null);
    try {
      const body = token ? { token } : {};
      const res = await fetch(`${API}/api/connectors/github/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) setTest({ ok: true, login: d.login });
      else setTest({ ok: false, error: d.error || 'O GitHub não aceitou o token.' });
    } catch (e) { setTest({ ok: false, error: e.message || 'Não foi possível testar agora.' }); }
    finally { setTesting(false); }
  }

  async function save() {
    if (!token.trim()) { showToast('Cole o token do GitHub antes de salvar.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/connectors/github`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.trim() }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error || 'Não foi possível conectar.');
      setToken(''); setTest(null);
      showToast(`GitHub conectado como @${d.login}.`, 'ok');
      load();
    } catch (e) { showToast(e.message || 'Não foi possível conectar o GitHub.'); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/connectors/github`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      setToken(''); setTest(null);
      showToast('GitHub desconectado.', 'ok');
      load();
    } catch { showToast('Não foi possível desconectar agora.'); }
    finally { setBusy(false); }
  }

  return <Drawer title="Conectores" icon={<Cable size={18}/>} onClose={onClose} className="providerDrawer">
    <p className="drawerIntro">Conecte serviços externos para o assistente trabalhar neles por você. Com o GitHub conectado, dá para clonar um repositório, fazer alterações e enviá-las de volta — pelo chat ou pelo modo desenvolvedor.</p>

    <div className="pcHint" style={{ color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <GitHubIcon size={18}/>
      <b>GitHub</b>
      {github === null && <span className="muted small">carregando...</span>}
      {github && (github.connected
        ? <span className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Check size={14} style={{ color: 'var(--ok)' }}/> conectado como <code>@{github.login}</code></span>
        : <span className="muted small">não conectado</span>)}
    </div>

    <label>Token de acesso do GitHub
      <input type="password" value={token} onChange={e => { setToken(e.target.value); setTest(null); }} placeholder="ghp_... ou github_pat_..." autoComplete="off"/>
    </label>
    <p className="muted small" style={{ margin: '-8px 0 0' }}>
      Crie em <code>github.com → Settings → Developer settings → Personal access tokens</code>. No token clássico, marque o escopo <code>repo</code>; no refinado (fine-grained), dê acesso de leitura e escrita a <b>Contents</b> e <b>Pull requests</b> dos repositórios desejados.
    </p>

    {test && (test.ok
      ? <div className="pcHint" style={{ color: 'var(--ok)' }}><Check size={14}/> Token válido{test.login ? <> — conta <code>@{test.login}</code></> : null}</div>
      : <div className="pcHint" style={{ color: 'var(--danger)' }}><X size={14}/> {test.error}</div>
    )}

    <div className="modalActions">
      <button onClick={runTest} disabled={testing || busy || (!token && !github?.connected)}>{testing ? <><span className="spin sm"/> Testando...</> : <><RefreshCw size={15}/> Testar</>}</button>
      <div className="spacer"/>
      {github?.connected && <button className="danger" onClick={disconnect} disabled={busy}>Desconectar</button>}
      <button className="primary" onClick={save} disabled={busy || !token.trim()}>{busy ? 'Salvando...' : 'Conectar'}</button>
    </div>

    <div className="pcHint">🔒 O token fica criptografado no servidor e nunca aparece por completo — nem para a IA: as operações autenticadas (clonar, enviar) rodam fora do sandbox. Depois de conectar, escolha um repositório como projeto no <b>Modo desenvolvedor</b>, ou peça direto no chat (ex.: "clone o repositório fulano/meu-app e corrija o erro X").</div>
  </Drawer>;
}
