const FALLBACK_MESSAGES = {
  compatibility: 'A tarefa não pode ser executada pelo modelo selecionado.',
  configuration: 'Nenhum provedor de IA utilizável para esta tarefa. Configure uma chave em Configurações › Provedor de IA.',
  provider: 'O provedor do modelo interrompeu a tarefa antes da conclusão.',
  incomplete: 'A tarefa terminou sem concluir o resultado solicitado.'
};

// A resposta do agente é rica para o chat, mas a fila precisa de um estado
// objetivo para não chamar de "concluída" uma tarefa que terminou em erro.
export function classifyTaskResult(result = {}) {
  if (result.stopped) {
    return { status: 'canceled', progress: 'Cancelada', error: null };
  }
  // PERGUNTA AO USUÁRIO não é falha. O agente pediu uma decisão (escopo, opção
  // A ou B, autorização) e parou — o correto é aguardar, não emitir
  // `execution_failed` e pintar a mensagem de vermelho no chat, como acontecia
  // quando um turno assim caía em `incomplete`.
  if (result.execution?.state === 'awaiting_user') {
    return { status: 'waiting_user', progress: 'Aguardando resposta', error: null };
  }
  if (result.compatibility) {
    return {
      status: 'error',
      progress: 'Modelo incompatível',
      error: result.failureMessage || FALLBACK_MESSAGES.compatibility
    };
  }
  // Dependência ausente (sem chave/provedor utilizável para o modelo) é falha
  // do AMBIENTE, nunca "concluída" (Regra 4.2): a resposta orienta o usuário,
  // mas a tarefa não foi feita.
  if (result.configurationError) {
    return {
      status: 'error',
      progress: 'Provedor não configurado',
      error: result.failureMessage || FALLBACK_MESSAGES.configuration
    };
  }
  if (result.providerFailure) {
    return {
      status: 'error',
      progress: 'Falha do provedor',
      error: result.failureMessage || FALLBACK_MESSAGES.provider
    };
  }
  if (result.incomplete) {
    return {
      status: 'error',
      progress: 'Não concluída',
      error: result.failureMessage || FALLBACK_MESSAGES.incomplete
    };
  }
  return { status: 'done', progress: 'Concluida', error: null };
}
