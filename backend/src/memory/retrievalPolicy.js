// Mensagens sem assunto nao possuem sinal suficiente para recuperar contexto
// externo. O historico da conversa atual continua sendo preservado pelo agente.
const LOW_SIGNAL_TURN_RE = /^(?:(?:oi+|oie+|ola+|opa+|e ai|hey|hello|hi|bom dia|boa tarde|boa noite)(?:\s+(?:tudo bem|como vai|como voce esta|como voce ta|tudo certo))?|ok(?:ay)?|beleza|certo|valeu|obrigad[oa]|sim|nao|continua|pode)$/;

function normalizeTurn(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isLowSignalTurn(text) {
  const normalized = normalizeTurn(text);
  return normalized.length > 0 && normalized.length <= 80 && LOW_SIGNAL_TURN_RE.test(normalized);
}

export const LOW_SIGNAL_TURN_NOTE = `A mensagem atual e apenas uma saudacao ou confirmacao breve. Responda de forma natural e curta. Nao use ferramentas, nao inicie analises, nao examine o workspace e nao recupere ou mencione conversas anteriores, arquivos ou memorias sem um pedido explicito do usuario.`;
