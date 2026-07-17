// Portão de autenticação: decide entre a tela de login e o app.
// - Enquanto verifica a sessão: tela de carregamento.
// - Sem sessão: tela de login/cadastro.
// - Com sessão: o app normal (todas as chamadas /api já levam o cookie).
import React from 'react';
import { useSession } from './authClient.js';
import { LoginScreen } from './LoginScreen.jsx';
import App from './App.jsx';

export default function AuthGate() {
  const { data: session, isPending } = useSession();

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

  if (!session) return <LoginScreen />;

  return <App user={session.user} />;
}
