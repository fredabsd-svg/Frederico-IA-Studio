// Privacidade e dados (LGPD) — o lugar onde o usuário exerce os direitos do
// titular sem precisar pedir a ninguém: exportar todos os dados (portabilidade),
// apagar todo o histórico de conversas e excluir a conta em definitivo.
// Também dá acesso à Política de Privacidade e aos Termos de Uso.
import React, { useState } from 'react';
import { ShieldCheck, Download, Trash2, UserX, ExternalLink } from 'lucide-react';
import { API } from './constants.js';
import { Drawer } from './components.jsx';
import { signOut } from './authClient.js';

export function PrivacyPanel({ user, showToast, askConfirm, askPrompt, onHistoryCleared, onClose }) {
  const [busy, setBusy] = useState('');

  function exportData() {
    // Download autenticado pelo cookie de sessão; o servidor manda como anexo.
    window.open(`${API}/api/account/export`, '_blank');
  }

  async function clearHistory() {
    const ok = await askConfirm({
      title: 'Apagar todo o histórico?',
      message: 'Todas as conversas, mensagens, arquivos e memórias extraídas delas serão excluídos em definitivo. Não há como desfazer.',
      confirmLabel: 'Apagar tudo',
      destructive: true,
    });
    if (!ok) return;
    setBusy('history');
    try {
      const res = await fetch(`${API}/api/account/conversations`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Não foi possível apagar o histórico.');
      showToast(`Histórico apagado (${d.deleted} conversa${d.deleted === 1 ? '' : 's'}).`, 'ok');
      onHistoryCleared?.();
    } catch (e) { showToast(e.message || 'Não foi possível apagar o histórico.'); }
    finally { setBusy(''); }
  }

  async function deleteAccount() {
    const email = String(user?.email || '');
    // O diálogo NÃO exibe o e-mail de propósito: a confirmação só faz sentido
    // se exigir que a pessoa SAIBA o e-mail da conta, não que o copie dali.
    const typed = await askPrompt({
      title: 'Excluir a conta em definitivo?',
      label: 'Isto apaga TUDO — conta, conversas, arquivos, memórias e chaves — sem volta. Para confirmar, digite o e-mail com o qual você entra nesta conta:',
      confirmLabel: 'Excluir minha conta',
    });
    if (typed == null) return;
    if (typed.trim().toLowerCase() !== email.trim().toLowerCase()) {
      showToast('O e-mail digitado não confere. A conta NÃO foi excluída.');
      return;
    }
    setBusy('account');
    try {
      const res = await fetch(`${API}/api/account`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Não foi possível excluir a conta.');
      // A conta não existe mais; encerra a sessão local e volta à vitrine.
      try { await signOut(); } catch {}
      window.location.href = '/';
    } catch (e) {
      showToast(e.message || 'Não foi possível excluir a conta.');
      setBusy('');
    }
  }

  return <Drawer title="Privacidade e dados" icon={<ShieldCheck size={18}/>} onClose={onClose} className="privacyDrawer">
    <p className="drawerIntro">
      Seus dados são seus. Aqui você baixa uma cópia de tudo, apaga o histórico ou exclui a conta —
      em definitivo, sem precisar pedir a ninguém (direitos do titular, art. 18 da LGPD).
    </p>

    <div className="privacyItem">
      <div className="privacyItemText">
        <b>Exportar meus dados</b>
        <span className="muted small">Baixa um arquivo JSON com o seu perfil, conversas, memórias, assistentes e configurações (sem senhas nem chaves).</span>
      </div>
      <button onClick={exportData} disabled={!!busy}><Download size={15}/> Exportar</button>
    </div>

    <div className="privacyItem">
      <div className="privacyItemText">
        <b>Apagar todo o histórico de conversas</b>
        <span className="muted small">Exclui em definitivo todas as conversas, mensagens, arquivos e as memórias extraídas delas.</span>
      </div>
      <button className="danger" onClick={clearHistory} disabled={!!busy}>
        {busy === 'history' ? <span className="spin sm"/> : <Trash2 size={15}/>} Apagar tudo
      </button>
    </div>

    <div className="privacyItem">
      <div className="privacyItemText">
        <b>Excluir minha conta</b>
        <span className="muted small">Remove a conta e TODOS os dados associados (hard delete). Sair é tão fácil quanto entrar.</span>
      </div>
      <button className="danger" onClick={deleteAccount} disabled={!!busy}>
        {busy === 'account' ? <span className="spin sm"/> : <UserX size={15}/>} Excluir conta
      </button>
    </div>

    <div className="pcHint">
      📄 Leia a <a href="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade <ExternalLink size={11}/></a> e
      os <a href="/termos" target="_blank" rel="noreferrer">Termos de Uso <ExternalLink size={11}/></a>.
      Dúvidas sobre privacidade? Escreva para o contato indicado na política.
    </div>
  </Drawer>;
}

// Modal bloqueante de aceite (LGPD): aparece para quem entrou por login social,
// para contas criadas antes do recurso e sempre que os termos mudam de versão.
// Só libera o app depois do aceite registrado no servidor.
export function ConsentGate({ onAccepted }) {
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');

  async function accept() {
    setBusy(true); setError('');
    try {
      const res = await fetch(`${API}/api/consent`, { method: 'POST' });
      if (!res.ok) throw new Error();
      onAccepted?.();
    } catch {
      setError('Não foi possível registrar o aceite. Verifique a conexão e tente de novo.');
      setBusy(false);
    }
  }

  return <div className="consentOverlay" role="dialog" aria-modal="true" aria-label="Termos de Uso e Política de Privacidade">
    <div className="consentCard">
      <div className="brand" style={{ justifyContent: 'center' }}>Frederico <span>AI Studio</span></div>
      <h2>Antes de continuar</h2>
      <p>
        Para usar o aplicativo, precisamos do seu aceite dos nossos documentos legais — eles explicam
        como os seus dados são tratados (LGPD) e as regras de uso do serviço.
      </p>
      <label className="loginConsent">
        <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />
        <span>
          Li e concordo com os <a href="/termos" target="_blank" rel="noreferrer">Termos de Uso</a> e
          a <a href="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</a>.
        </span>
      </label>
      {error && <p className="loginError">{error}</p>}
      <div className="consentActions">
        <button onClick={async () => { try { await signOut(); } catch {} window.location.href = '/'; }} disabled={busy}>Sair</button>
        <button className="primary" onClick={accept} disabled={!checked || busy}>
          {busy ? 'Registrando…' : 'Aceitar e continuar'}
        </button>
      </div>
    </div>
  </div>;
}
