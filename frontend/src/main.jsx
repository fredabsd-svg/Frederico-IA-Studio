import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthGate from './AuthGate.jsx';
import './styles.css';
import './v2.css';
import './auth.css';
import './landing.css';
import './camera.css';
createRoot(document.getElementById('root')).render(<AuthGate />);
