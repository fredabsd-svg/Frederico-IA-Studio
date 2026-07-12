import React from 'react';
import { Wrench } from 'lucide-react';
import { Modal } from './components.jsx';
import { EMBEDDED_APPS } from './constants.js';

// Painel de "Ferramentas" (apps embutidos). Cada card prepara um pedido guiado
// e joga o usuário direto numa conversa nova com o texto pronto.
export function ToolsPanel({ onPick, onClose }) {
  return <Modal title="Ferramentas" icon={<Wrench size={18}/>} onClose={onClose}>
    <p className="muted" style={{ margin: 0 }}>Fluxos prontos para tarefas do dia a dia. Escolha um, anexe o arquivo quando pedido e clique em <b>Enviar</b> — a IA faz o resto e gera o arquivo final.</p>
    <div className="toolGrid">
      {EMBEDDED_APPS.map((a, i) => (
        <button key={i} className="toolCard" onClick={() => onPick(a)}>
          <span className="tcIcon" aria-hidden="true">{a.icon}</span>
          <span className="tcText">
            <b>{a.title}</b>
            <small>{a.desc}</small>
          </span>
          {a.needsFile && <span className="tcBadge">📎 anexo</span>}
        </button>
      ))}
    </div>
  </Modal>;
}
