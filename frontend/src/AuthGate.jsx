// Portão de autenticação: decide entre a tela de login e o app.
// - Enquanto verifica a sessão: tela de carregamento.
// - Sem sessão: tela de login/cadastro.
// - Com sessão: o app normal (todas as chamadas /api já levam o cookie).
import React, { useEffect } from 'react';
import { useSession } from './authClient.js';
import Landing from './Landing.jsx';
import App from './App.jsx';
import { THEMES } from './constants.js';

export default function AuthGate() {
  const { data: session, isPending } = useSession();

  // O tema só é aplicado dentro do App (logado). Antes do login, o <body> ficava
  // sem classe de tema e as telas públicas (landing/login) perdiam as cores.
  // Aqui aplicamos o tema salvo (ou o padrão) para a vitrine e o login já
  // aparecerem no visual certo.
  useEffect(() => {
    if (session) return; // logado: o App cuida do tema
    const saved = localStorage.getItem('fred_theme');
    const t = THEMES.find(x => x.id === saved) || THEMES[0];
    document.body.className = `${t.mode} t-${t.id}`;
  }, [session]);

  if (isPending) {
    return (
      <div className="connError">
        <div className="connErrorCard">
          <div className="brand" style={{ marginBottom: 0 }}>Frederico <span>AI Studio</span></div>
          <p>Carregando…</p>
        </div>
      </div>
    );
  }

  if (!session) return <Landing />;

  return <App user={session.user} />;
}
