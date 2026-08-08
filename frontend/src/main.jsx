import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthGate from './AuthGate.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { PrivacyPolicy, TermsOfUse } from './LegalPages.jsx';
import './styles.css';
import './v2.css';
import './auth.css';
import './landing.css';
import './dev-handoff.css';
import './camera.css';
import './companion.css';
import './nino.css';
import './docling.css';
import './copilot.css';
import './design.css';

// Rotas públicas dos documentos legais (LGPD) — funcionam sem login, tanto no
// Vite (fallback de SPA) quanto no Caddy (try_files -> index.html).
const route = window.location.pathname.replace(/\/+$/, '');
const page = route === '/privacidade' ? <PrivacyPolicy />
  : route === '/termos' ? <TermsOfUse />
  : <AuthGate />;
createRoot(document.getElementById('root')).render(<ErrorBoundary>{page}</ErrorBoundary>);
