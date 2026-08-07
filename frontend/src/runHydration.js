// Hidratação das execuções DURÁVEIS (agent_runs / agent_run_events).
//
// Depois de um reload (ou ao reabrir uma conversa antiga), as etapas de
// ferramenta não existem mais no estado do React — mas existem no banco, com
// timestamps REAIS do servidor. Este módulo busca os runs persistidos e
// devolve as mensagens com os `blocks` reconstruídos na MESMA forma que o
// useChat produz ao vivo, para o terminal, a linha de execução e os rails
// funcionarem idênticos nos dois caminhos.
//
// Falha de rede aqui nunca quebra a conversa: devolve as mensagens como vieram.
//
// `constants.js` usa import.meta.env (Vite) e explodiria nos testes de nó puro
// deste módulo — por isso o import é DINÂMICO, só dentro da função que faz
// fetch. As funções puras (testadas) não tocam rede nem ambiente.

// Converte os passos persistidos (runLog.stepsFromRunEvents, backend) para os
// blocos de ferramenta do useChat. PURA (testável). `started`/`ended` chegam
// como ISO do servidor e viram epoch-ms — o mesmo formato do caminho ao vivo.
export function blocksFromRunSteps(steps, content = '') {
  const toolBlocks = (steps || []).map(step => ({
    type: 'tool',
    id: step.id || null,
    name: step.name || '',
    preview: step.preview || '',
    detail: step.detail || '',
    subagent: step.subagent || null,
    parentId: step.parentId || null,
    status: step.status || 'done',
    ...(step.started ? { started: Date.parse(step.started) || undefined } : {}),
    ...(step.ended ? { ended: Date.parse(step.ended) || undefined } : {}),
    ...(step.result != null ? { result: step.result } : {}),
    ...(step.thumb ? { thumb: step.thumb } : {})
  }));
  // O texto da resposta entra como bloco final — é a ordem visual do caminho
  // ao vivo (ferramentas acima, resposta abaixo).
  return String(content || '').trim() ? [...toolBlocks, { type: 'text', content }] : toolBlocks;
}

// Aplica os runs persistidos às mensagens. PURA (testável): casa run→mensagem
// por message_id (preferência) ou pelo runId do execution_meta; nunca mexe em
// mensagem que já tem blocks (o caminho ao vivo tem prioridade).
export function applyRunsToMessages(messages, runs) {
  if (!Array.isArray(runs) || !runs.length) return messages;
  const byMessage = new Map(runs.filter(run => run.messageId).map(run => [run.messageId, run]));
  const byRunId = new Map(runs.map(run => [run.runId, run]));
  return (messages || []).map(message => {
    if (message.role !== 'assistant' || (message.blocks || []).length) return message;
    const run = byMessage.get(message.id)
      || (message.execution?.runId ? byRunId.get(message.execution.runId) : null);
    if (!run || !run.steps?.length) return message;
    return {
      ...message,
      blocks: blocksFromRunSteps(run.steps, message.content),
      ...(run.plan && !message.plan ? { plan: run.plan } : {})
    };
  });
}

// Busca os runs da conversa e devolve as mensagens hidratadas.
export async function hydrateMessagesWithRuns(conversationId, messages) {
  const hasExecution = (messages || []).some(message => message.role === 'assistant' && message.execution);
  if (!conversationId || !hasExecution) return messages;
  try {
    const { API } = await import('./constants.js');
    const res = await fetch(`${API}/api/conversations/${conversationId}/runs`);
    if (!res.ok) return messages;
    const data = await res.json();
    return applyRunsToMessages(messages, data.runs);
  } catch {
    return messages;
  }
}
