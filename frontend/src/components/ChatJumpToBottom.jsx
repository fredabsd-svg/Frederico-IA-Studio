import React from 'react';
import { ArrowDown } from 'lucide-react';

// Botão flutuante "Ir para o final".
//
// Aparece quando há conteúdo novo abaixo do que a pessoa está lendo. Durante o
// streaming o rótulo muda para "Nova resposta abaixo" — a informação é a mesma,
// mas a urgência não: no primeiro caso ela só rolou para cima, no segundo a IA
// está escrevendo agora.
//
// Fica DENTRO do fluxo do layout do chat (não sobre as mensagens, não sobre o
// compositor, não sobre o terminal): a posição é ancorada ao rodapé da área de
// mensagens pelo CSS, com `pointer-events` só no próprio botão.
export function ChatJumpToBottom({ visible, streaming = false, onClick }) {
  if (!visible) return null;
  const label = streaming ? 'Nova resposta abaixo' : 'Ir para o final';
  return (
    <div className="chatJumpWrap">
      <button
        type="button"
        className={`chatJump ${streaming ? 'streaming' : ''}`}
        onClick={onClick}
        aria-label={streaming ? 'Nova resposta abaixo — ir para o final da conversa' : 'Ir para o final da conversa'}
        title={label}
      >
        <ArrowDown size={15} aria-hidden="true" />
        <span>{label}</span>
      </button>
    </div>
  );
}
