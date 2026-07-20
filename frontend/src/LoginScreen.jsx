// Tela de Entrar / Criar conta — e-mail/senha + GitHub + Google.
// Visual alinhado ao app (cartão central sobre o fundo). Ao concluir, a sessão
// é criada e o AuthGate troca automaticamente para o app.
import React, { useEffect, useState } from 'react';
import { RefreshCw, ArrowLeft, ShieldCheck, Lock, Scale } from 'lucide-react';
import { signIn, signUp, traduzErroAuth } from './authClient.js';
import { callbackURLForOrigin } from './authUrls.js';

export function LoginScreen({ initialMode = 'login', onBack = null }) {
  const [mode, setMode] = useState(initialMode === 'signup' ? 'signup' : 'login'); // 'login' | 'signup'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [social, setSocial] = useState('');
  // Provedores sociais habilitados NO SERVIDOR (via /api/health). Só mostra os
  // botões que realmente funcionam; null = ainda carregando (mostra os dois).
  const [provedores, setProvedores] = useState(null);

  useEffect(() => {
    let ativo = true;
    fetch('/api/health')
      .then(r => r.json())
      .then(h => { if (ativo) setProvedores(Array.isArray(h?.socialProviders) ? h.socialProviders : ['github', 'google']); })
      .catch(() => { if (ativo) setProvedores(['github', 'google']); });
    return () => { ativo = false; };
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { error } = await signUp.email({ email, password, name: name.trim() || email.split('@')[0] });
        if (error) { setError(traduzErroAuth(error)); return; }
      } else {
        const { error } = await signIn.email({ email, password });
        if (error) { setError(traduzErroAuth(error)); return; }
      }
      // Sucesso: a sessão foi criada; o AuthGate (useSession) mostra o app.
    } catch {
      setError('Não foi possível conectar ao servidor. Verifique se o app está no ar.');
    } finally {
      setBusy(false);
    }
  }

  async function entrarCom(provider) {
    setError('');
    setSocial(provider);
    try {
      // Redireciona para o GitHub/Google e volta para a raiz já logado.
      const callbackURL = callbackURLForOrigin(window.location.origin);
      // A Better Auth devolve { error } em vez de lançar — sem tratar, o botão
      // ficava girando para sempre e travava o formulário inteiro.
      const { error } = (await signIn.social({ provider, callbackURL })) || {};
      if (error) {
        setSocial('');
        setError(traduzErroAuth(error));
      }
      // Sem erro: o navegador já está sendo redirecionado ao provedor.
    } catch {
      setSocial('');
      setError('Não foi possível iniciar o login social.');
    }
  }

  const isSignup = mode === 'signup';

  return (
    <div className="loginWrap">
      <div className="loginCard">
        {onBack && (
          <button type="button" className="lpBack" onClick={onBack}>
            <ArrowLeft size={15} /> Voltar
          </button>
        )}
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 4 }}>Frederico <span>AI Studio</span></div>
        <p className="loginSub">{isSignup ? 'Crie sua conta para começar.' : 'Entre para continuar.'}</p>

        {(provedores === null || provedores.length > 0) && (
          <>
            <div className="loginSocial">
              {(provedores === null || provedores.includes('github')) && (
                <button type="button" className="socialBtn" onClick={() => entrarCom('github')} disabled={busy || !!social}>
                  {social === 'github' ? <RefreshCw size={18} className="spinIcon" /> : <GitHubIcon />} Continuar com GitHub
                </button>
              )}
              {(provedores === null || provedores.includes('google')) && (
                <button type="button" className="socialBtn" onClick={() => entrarCom('google')} disabled={busy || !!social}>
                  {social === 'google' ? <RefreshCw size={18} className="spinIcon" /> : <GoogleIcon />} Continuar com Google
                </button>
              )}
            </div>

            <div className="loginOr"><span>ou com e-mail</span></div>
          </>
        )}

        <form onSubmit={submit} className="loginForm">
          {isSignup && (
            <input className="loginInput" type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Seu nome" autoComplete="name" />
          )}
          <input className="loginInput" type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="E-mail" autoComplete="email" required autoFocus />
          <input className="loginInput" type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder={isSignup ? 'Crie uma senha (mín. 8 caracteres)' : 'Senha'}
            autoComplete={isSignup ? 'new-password' : 'current-password'} required minLength={8} />
          {error && <p className="loginError">{error}</p>}
          <button className="primary" type="submit" disabled={busy || !!social}>
            {busy && <RefreshCw size={18} className="spinIcon" />} {isSignup ? 'Criar conta' : 'Entrar'}
          </button>
        </form>

        <p className="loginToggle">
          {isSignup ? 'Já tem conta?' : 'Ainda não tem conta?'}{' '}
          <button type="button" onClick={() => { setMode(isSignup ? 'login' : 'signup'); setError(''); }}>
            {isSignup ? 'Entrar' : 'Criar conta'}
          </button>
        </p>
      </div>

      {/* Selos de segurança — o usuário vê ANTES de entrar que o ambiente é
          protegido: antivírus nos arquivos, conexão cifrada e LGPD. */}
      <div className="loginTrust">
        <span><ShieldCheck size={13} /> Arquivos verificados por antivírus</span>
        <span><Lock size={13} /> Conexão criptografada</span>
        <span><Scale size={13} /> Compromisso com a LGPD</span>
      </div>
    </div>
  );
}

// Ícone do GitHub (SVG inline) — os ícones de marca saíram do lucide-react.
function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58C20.56 22.29 24 17.79 24 12.5 24 5.87 18.63.5 12 .5z"/>
    </svg>
  );
}

// Ícone do Google (SVG inline, cores oficiais) — evita dependência externa.
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}
