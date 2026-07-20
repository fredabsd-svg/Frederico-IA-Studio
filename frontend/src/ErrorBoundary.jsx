// Rede de segurança do React: um erro de runtime em qualquer componente
// derrubava a árvore inteira e deixava a tela em branco, sem saída além do F5.
// Este boundary captura o erro, registra no console (para diagnóstico) e mostra
// uma mensagem amigável com um botão de recarregar — nada de tela branca.
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center',
        fontFamily: 'system-ui, sans-serif', color: 'var(--text, #333)'
      }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Algo deu errado por aqui 😕</h1>
        <p style={{ maxWidth: 420, margin: 0, opacity: 0.8 }}>
          Ocorreu um erro inesperado na interface. Suas conversas e arquivos estão
          salvos no servidor — basta recarregar a página para continuar.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: '#1A3C6E', color: '#fff', fontSize: 14
          }}
        >
          Recarregar a página
        </button>
      </div>
    );
  }
}
