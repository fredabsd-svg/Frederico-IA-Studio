const FALLBACK_MESSAGES = {
  compatibility: 'A tarefa nao pode ser executada pelo modelo selecionado.',
  provider: 'O provedor do modelo interrompeu a tarefa antes da conclusao.',
  incomplete: 'A tarefa terminou sem concluir o resultado solicitado.'
};

// A resposta do agente e rica para o chat, mas a fila precisa de um estado
// objetivo para nao chamar de "concluida" uma tarefa que terminou em erro.
export function classifyTaskResult(result = {}) {
  if (result.stopped) {
    return { status: 'canceled', progress: 'Cancelada', error: null };
  }
  if (result.compatibility) {
    return {
      status: 'error',
      progress: 'Modelo incompativel',
      error: result.failureMessage || FALLBACK_MESSAGES.compatibility
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
      progress: 'Nao concluida',
      error: result.failureMessage || FALLBACK_MESSAGES.incomplete
    };
  }
  return { status: 'done', progress: 'Concluida', error: null };
}
