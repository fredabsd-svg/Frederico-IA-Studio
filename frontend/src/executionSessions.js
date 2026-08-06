// Sessões de execução da conversa — FONTE ÚNICA.
//
// Antes, "quais são as etapas desta resposta" e "esta execução está ao vivo?"
// eram recalculados dentro do JSX do App.jsx, e o cartão dentro do balão era o
// único lugar que sabia disso. Com o terminal inferior, três consumidores
// precisam da mesma informação (o terminal, a linha compacta no histórico e o
// overlay em tela cheia). Duplicar a transformação em cada um deles seria a
// receita para eles discordarem.
//
// Aqui a conversa é lida uma vez e vira uma lista de sessões: uma por mensagem
// de assistente que executou ferramentas, na ordem da conversa.

// Identidade estável da sessão: a mesma chave de render da mensagem. O `_key`
// vem antes do `id` de propósito — o evento `saved` troca o id temporário pelo
// id do banco no meio do streaming, e usar o id faria a sessão "trocar" no meio.
export function sessionIdOf(message, index = 0) {
  return String(message?._key || message?.id || `msg-${index}`);
}

// Uma sessão está AO VIVO quando alguma etapa dela ainda roda, ou quando é a
// última mensagem da conversa e a conversa está processando.
export function collectExecutionSessions(messages = [], { busy = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const sessions = [];
  list.forEach((message, index) => {
    if (message?.role !== 'assistant') return;
    const steps = (message.blocks || []).filter(block => block?.type === 'tool');
    if (!steps.length) return;
    const running = steps.some(step => step.status === 'running');
    sessions.push({
      id: sessionIdOf(message, index),
      messageIndex: index,
      steps,
      live: running || (busy && index === list.length - 1),
      errors: steps.filter(step => step.status === 'error').length,
      createdAt: message.created_at || null
    });
  });
  return sessions;
}

// A sessão que o terminal deve mostrar por padrão: a que está ao vivo; senão, a
// última da conversa (para o usuário reabrir os detalhes sem procurar).
export function activeExecutionSession(sessions = []) {
  const list = Array.isArray(sessions) ? sessions : [];
  return list.find(session => session.live) || list[list.length - 1] || null;
}

// Escolhe a sessão a exibir: a fixada pelo usuário ("Ver no terminal"), desde que
// ainda exista; caso contrário a ativa. Uma execução nova AO VIVO tem
// precedência — ela é o que está acontecendo agora.
export function pickTerminalSession(sessions = [], pinnedId = null) {
  const list = Array.isArray(sessions) ? sessions : [];
  const live = list.find(session => session.live);
  if (live) return live;
  if (pinnedId) {
    const pinned = list.find(session => session.id === pinnedId);
    if (pinned) return pinned;
  }
  return activeExecutionSession(list);
}

const plural = (n, singular, pluralWord) => `${n} ${n === 1 ? singular : pluralWord}`;

export function formatDuration(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}min ${s}s` : `${m}min`;
}

// Resumo de uma sessão: contagens + duração. `now` entra por parâmetro para o
// relógio viver DENTRO do terminal — sem isso, o chat inteiro re-renderizaria a
// cada segundo só para atualizar um contador.
export function summarizeSession(steps = [], now = 0) {
  const list = Array.isArray(steps) ? steps : [];
  const count = name => list.filter(step => step?.name === name).length;
  const files = count('write_file') + count('zip_outputs') + count('generate_image');
  const commands = count('bash') + count('run_python');
  const searches = count('web_search') + count('web_fetch');
  const reads = count('read_file') + count('list_files');
  const delegations = count('delegar_subagente');
  const errors = list.filter(step => step?.status === 'error').length;
  const running = list.some(step => step?.status === 'running');
  const starts = list.map(step => step?.started).filter(Boolean);
  const ends = list.map(step => step?.ended).filter(Boolean);
  const first = starts.length ? Math.min(...starts) : now;
  const last = running || !ends.length ? now : Math.max(...ends);
  return {
    total: list.length,
    files, commands, searches, reads, delegations, errors, running,
    elapsedMs: Math.max(0, last - first),
    elapsed: formatDuration(Math.max(0, last - first))
  };
}

// Estado exibido no cabeçalho do terminal. `awaitingUser` vem do estado de
// execução da mensagem — uma pergunta não é "concluído" nem "falhou".
// `label` é o rótulo do cabeçalho ("Executando"); `historyLabel` concorda com
// "Execução" na linha do histórico ("Execução concluída"), sem inventar
// concordância na hora de montar a frase.
export function terminalStatus({ live = false, awaitingUser = false, stopped = false, errors = 0 } = {}) {
  if (awaitingUser) return { key: 'awaiting', label: 'Aguardando resposta', historyLabel: 'aguardando resposta', tone: 'warn' };
  if (live) return { key: 'running', label: 'Executando', historyLabel: 'em andamento', tone: 'live' };
  if (stopped) return { key: 'stopped', label: 'Interrompido', historyLabel: 'interrompida', tone: 'warn' };
  if (errors > 0) return { key: 'warn', label: 'Concluído com avisos', historyLabel: 'concluída com avisos', tone: 'warn' };
  return { key: 'done', label: 'Concluído', historyLabel: 'concluída', tone: 'ok' };
}

// Linha de resumo do histórico: "Execução concluída · 84 etapas · 3 arquivos · 10min 35s".
export function sessionSummaryLine(sum, { live = false, awaitingUser = false, stopped = false } = {}) {
  const status = terminalStatus({ live, awaitingUser, stopped, errors: sum.errors });
  const parts = [plural(sum.total, 'etapa', 'etapas')];
  if (sum.files) parts.push(plural(sum.files, 'arquivo', 'arquivos'));
  if (sum.commands) parts.push(plural(sum.commands, 'comando', 'comandos'));
  if (sum.searches) parts.push(plural(sum.searches, 'pesquisa', 'pesquisas'));
  if (sum.delegations) parts.push(plural(sum.delegations, 'delegação', 'delegações'));
  if (sum.errors) parts.push(plural(sum.errors, 'erro', 'erros'));
  parts.push(sum.elapsed);
  return `Execução ${status.historyLabel} · ${parts.join(' · ')}`;
}

// Solicitação de decisão pendente na conversa (`ask_user` ou o fallback textual).
//
// Ela é considerada RESOLVIDA quando existe uma mensagem do usuário DEPOIS da
// mensagem que a trouxe — foi assim que ele respondeu. Sem esta regra, o cartão
// "Aguardando sua resposta" ficaria pendurado para sempre no histórico.
export function pendingInputRequest(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (message?.role !== 'assistant') continue;
    const request = message.execution?.inputRequest || message.inputRequest || null;
    if (!request?.id) continue;
    const answered = list.slice(i + 1).some(m => m?.role === 'user');
    return { request, messageIndex: i, messageId: sessionIdOf(message, i), resolved: answered };
  }
  return null;
}
