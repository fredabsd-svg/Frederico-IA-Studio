import React from 'react';
import { Check, CircleHelp, ListChecks, MessageSquare } from 'lucide-react';

// Perguntas interativas da IA (evento SSE `input_required`, persistido em
// `execution_meta.inputRequest`).
//
// Um pedido de decisão NÃO é erro: em vez do balão vermelho com "Reenviar", a
// mensagem passa a mostrar um cartão com a pergunta e a forma certa de responder
// — texto livre, confirmação (dois botões) ou seleção entre opções.
//
// Fechar o modal NÃO descarta a solicitação: o cartão inline continua na mensagem
// com o botão "Responder". A solicitação sobrevive ao reload porque vem do
// `execution_meta`, e desaparece sozinha quando existe uma mensagem posterior do
// usuário (ou seja, quando já foi respondida).

// Mesmo mapa de ícones usado pelo modal (UserInputRequestDialog.jsx) — exportado
// daqui para não haver duas listas divergindo.
export const KIND_ICON = { text: MessageSquare, confirm: CircleHelp, select: ListChecks };

// ─── Cartão inline (dentro da mensagem) ─────────────────────────────────────
export function UserInputRequestCard({ request, onOpen, resolved = false }) {
  if (!request) return null;
  const Icon = KIND_ICON[request.kind] || CircleHelp;
  return (
    <div className={`inputReqCard ${resolved ? 'resolved' : ''}`}>
      <span className="inputReqIcon" aria-hidden="true">
        {resolved ? <Check size={16} /> : <Icon size={16} />}
      </span>
      <div className="inputReqText">
        <b>{resolved ? 'Pergunta respondida' : 'Aguardando sua resposta'}</b>
        <span>{request.question}</span>
      </div>
      {!resolved && (
        <button type="button" className="inputReqOpen" onClick={onOpen}>
          Responder
        </button>
      )}
    </div>
  );
}
