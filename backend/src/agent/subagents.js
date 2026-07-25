// Sub-agentes: delegação em TEMPO DE EXECUÇÃO.
//
// Diferente do Modo Equipe (orchestrator.js), onde os especialistas são
// escolhidos ANTES pela interface e não executam ferramentas, aqui é o próprio
// agente principal que decide, no meio do trabalho, delegar uma subtarefa. O
// sub-agente roda um `runAgent` COMPLETO (com ferramentas de verdade) numa
// janela de contexto PRÓPRIA e DESCARTÁVEL, e devolve ao pai apenas o
// resultado — nunca o histórico. É isso que evita entupir o contexto do agente
// principal em tarefas longas.
//
// O sub-agente compartilha a MESMA conversa (mesmo workspace/sandbox), então os
// arquivos que ele gera caem em outputs/ e aparecem normalmente para o usuário.
// O que ele NÃO faz: gravar mensagens na conversa, gravar checkpoint e delegar
// de novo (ver os guard-rails abaixo).

import { db } from '../db.js';

export const SUBAGENT_TOOL_NAME = 'delegar_subagente';

// Profundidade máxima: 1 = o agente principal delega, o sub-agente NÃO delega.
// Sem esse teto, uma cascata de delegações queima a chave do usuário em minutos.
export const MAX_SUBAGENT_DEPTH = 1;
const DEFAULT_MAX_SUBAGENTS_PER_RUN = 4;
const DEFAULT_RESULT_CHARS = 8000;
const DEFAULT_TASK_CHARS = 6000;

// Eventos do filho repassados ao stream do pai. `delta` fica de FORA de
// propósito: o texto do sub-agente não pode vazar para dentro da resposta do
// agente principal. `saved`, `files`, `execution_state` e `resumable` também
// ficam de fora — quem responde ao usuário é o pai.
const FORWARDED_EVENTS = new Set(['tool_start', 'tool_result']);

export function maxSubagentsPerRun() {
  const configured = Number(process.env.SUBAGENT_MAX_PER_RUN);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_SUBAGENTS_PER_RUN;
  return Math.min(Math.floor(configured), 10);
}

// Quantas delegações do MESMO lote podem correr ao mesmo tempo. As paralelas
// dividem o sandbox da conversa e disputam o mesmo provedor, então o padrão é
// conservador: ganho de tempo real sem multiplicar rate limit e CPU.
export function maxParallelSubagents() {
  const configured = Number(process.env.SUBAGENT_MAX_PARALLEL);
  if (!Number.isFinite(configured) || configured <= 0) return 2;
  return Math.min(Math.floor(configured), 4);
}

// Limitador de concorrência: a tarefa começa assim que houver vaga e a chamada
// devolve, na hora, a promessa do resultado — quem lança não bloqueia.
export function createSubagentLimiter(limit = maxParallelSubagents()) {
  const active = new Set();
  return (task) => {
    const slot = active.size >= limit ? Promise.race([...active]) : Promise.resolve();
    const promise = slot.then(task);
    // A fila só acompanha a CONCLUSÃO (erro incluído) — uma rejeição aqui não
    // pode derrubar o Promise.race de quem está esperando vaga.
    const tracked = promise.then(() => {}, () => {}).then(() => { active.delete(tracked); });
    active.add(tracked);
    return promise;
  };
}

export function subagentResultChars() {
  const configured = Number(process.env.SUBAGENT_RESULT_CHARS);
  return Number.isFinite(configured) && configured >= 1000 ? Math.floor(configured) : DEFAULT_RESULT_CHARS;
}

// Desligável por ambiente (SUBAGENTS_ENABLED=false) sem tocar no código.
export function subagentsEnabled() {
  return String(process.env.SUBAGENTS_ENABLED || '').toLowerCase() !== 'false';
}

export const subagentToolDefinition = {
  type: 'function',
  function: {
    name: SUBAGENT_TOOL_NAME,
    description: 'Delega uma subtarefa AUTOCONTIDA a um sub-agente com contexto próprio, que executa ferramentas e devolve só o resultado final. Use quando a subtarefa for pesada e isolável (varrer muitos arquivos, analisar um documento longo, apurar um ponto específico, testar uma hipótese) e o detalhe do caminho NÃO precisar ocupar esta conversa. Não use para pedidos curtos que você já resolve direto — delegar custa tempo e tokens. O sub-agente NÃO vê esta conversa: escreva a tarefa completa, com todos os dados necessários.',
    parameters: {
      type: 'object',
      properties: {
        tarefa: { type: 'string', description: 'Instrução completa e autocontida, com todo o contexto necessário (caminhos de arquivo, números, regras). O sub-agente não enxerga o histórico desta conversa.' },
        entregar: { type: 'string', description: 'O que deve voltar como resultado: um resumo, uma tabela, o caminho de um arquivo gerado, uma conclusão objetiva.' },
        especialista: { type: 'string', description: '(opcional) nome exato de um assistente cadastrado no Assistant Studio, para o sub-agente usar o prompt e as ferramentas dele.' }
      },
      required: ['tarefa']
    }
  }
};

// Decide se a ferramenta de delegação é OFERECIDA ao modelo nesta execução.
// Pura de propósito (sem I/O): é o ponto testável dos guard-rails.
export function shouldOfferSubagentTool({ depth = 0, lowSignalTurn = false, providerSource = null, hasTools = true } = {}) {
  if (!subagentsEnabled()) return false;
  if (lowSignalTurn) return false;          // "oi", "obrigado" — nada a delegar
  if (!hasTools) return false;              // sem ferramentas, delegar não faz sentido
  if (depth >= MAX_SUBAGENT_DEPTH) return false;
  if (providerSource === 'free') return false; // modo gratuito não banca delegação
  return true;
}

// O sub-agente nunca recebe mais fôlego que o pai: esforços altos são limitados
// para a subtarefa não virar uma segunda execução completa.
export function subagentEffort(parentEffort) {
  return parentEffort === 'extra' || parentEffort === 'max' ? 'alto' : (parentEffort || 'medio');
}

// Monta o texto que o sub-agente recebe como pedido. Ele parte de uma conversa
// vazia, então tudo que importa precisa estar aqui.
export function buildSubagentTask(args = {}) {
  const tarefa = String(args.tarefa || '').trim().slice(0, DEFAULT_TASK_CHARS);
  const entregar = String(args.entregar || '').trim().slice(0, 600);
  const parts = [tarefa];
  parts.push(entregar
    ? `\nENTREGUE AO FINAL: ${entregar}`
    : '\nENTREGUE AO FINAL: um resumo objetivo do que foi feito e do resultado obtido.');
  parts.push('Você é um sub-agente executando uma subtarefa delegada por outro agente. Você não participa da conversa com a pessoa e não vê o histórico dela: trabalhe apenas com o que está escrito acima. Execute de fato (ferramentas, arquivos, verificação) e responda só com o resultado — sem saudação, sem se apresentar e sem perguntar de volta. Se algo essencial faltar, diga exatamente o que faltou.');
  return parts.join('\n');
}

// Normaliza o retorno do runAgent no JSON compacto que volta como resultado da
// ferramenta. É o ÚNICO conteúdo do sub-agente que entra no contexto do pai.
export function summarizeSubagentResult(result, { especialista = null, limit = null } = {}) {
  if (!result) return { ok: false, error: 'O sub-agente não retornou resultado.', code: 'SUBAGENT_EMPTY' };
  if (result.stopped) return { ok: false, error: 'Execução interrompida pelo usuário.', code: 'CANCELED' };
  const max = limit || subagentResultChars();
  const texto = String(result.text || '').trim();
  return {
    ok: !result.incomplete && !result.providerFailure,
    ...(especialista ? { especialista } : {}),
    resultado: texto.length > max ? `${texto.slice(0, max)}\n…[resultado truncado]` : texto,
    ...(Array.isArray(result.files) && result.files.length
      ? { arquivos: result.files.map(file => String(file?.path || file || '')).filter(Boolean).slice(0, 40) }
      : {}),
    ...(result.incomplete || result.providerFailure
      ? { error: result.failureMessage || 'O sub-agente não concluiu a subtarefa.', code: 'SUBAGENT_INCOMPLETE' }
      : {})
  };
}

// Filtra e etiqueta os eventos do filho antes de repassá-los ao stream do pai.
// O `id` da chamada é prefixado com o id da delegação: com duas delegações em
// paralelo, os ids de ferramenta dos dois filhos poderiam coincidir e a
// interface fecharia o cartão errado.
export function subagentEventForwarder(onEvent, label, delegationId = '') {
  return (event) => {
    if (!event || !FORWARDED_EVENTS.has(event.type)) return;
    onEvent({
      ...event,
      ...(event.id ? { id: `${delegationId}:${event.id}` } : {}),
      subagent: label,
      ...(delegationId ? { parentId: delegationId } : {})
    });
  };
}

// Busca o assistente pelo NOME (o modelo escreve o nome, não o id). Sem match,
// o sub-agente roda com o assistente padrão — delegar nunca falha por causa de
// um nome digitado errado.
export async function findSubagentAssistant(userId, name) {
  const wanted = String(name || '').trim();
  if (!userId || !wanted) return null;
  try {
    const row = await db.prepare('SELECT * FROM assistants WHERE user_id=? AND lower(name)=lower(?) ORDER BY created_at ASC LIMIT 1')
      .get(userId, wanted);
    if (!row) return null;
    const parse = (value, fallback) => {
      if (value == null) return fallback;
      if (typeof value === 'object') return value;
      try { return JSON.parse(value); } catch { return fallback; }
    };
    return { ...row, tools: parse(row.tools, []), personality: parse(row.personality, {}) };
  } catch (err) {
    console.error('[subagente] falha ao carregar o especialista:', err.message);
    return null;
  }
}

// Import tardio do loop: `loop.js` importa este módulo, então uma importação
// estática de volta fecharia um ciclo no carregamento.
let runAgentRef = null;
async function loadRunAgent() {
  if (!runAgentRef) ({ runAgent: runAgentRef } = await import('./loop.js'));
  return runAgentRef;
}

// Executa a delegação. Devolve SEMPRE uma string JSON (o contrato de resultado
// de ferramenta do loop) e, junto, a usage do filho para o pai somar na dele.
export async function runSubagent({
  userId,
  conversationId,
  args = {},
  model,
  effort,
  control,
  onEvent,
  depth = 0,
  webSearch = false,
  delegationId = '',
  runner = null
}) {
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return { result: JSON.stringify({ error: 'Um sub-agente não pode delegar para outro sub-agente. Execute a subtarefa você mesmo.', code: 'SUBAGENT_DEPTH' }), usage: null };
  }
  const tarefa = String(args.tarefa || '').trim();
  if (!tarefa) {
    return { result: JSON.stringify({ error: 'Descreva a subtarefa no parâmetro "tarefa".', code: 'SUBAGENT_EMPTY_TASK' }), usage: null };
  }

  const assistant = await findSubagentAssistant(userId, args.especialista);
  const label = assistant?.name || String(args.especialista || '').trim() || 'sub-agente';
  const runAgent = runner || await loadRunAgent();

  onEvent({ type: 'status', content: `Delegando para ${label}...` });
  let result;
  try {
    result = await runAgent({
      userId,
      conversationId,                   // mesmo workspace/sandbox do pai
      userText: buildSubagentTask(args),
      model: assistant?.model || model,
      assistant,
      webSearch,
      effort: subagentEffort(effort),
      control,                          // herda pausar/parar do pai
      onEvent: subagentEventForwarder(onEvent, label, delegationId),
      saveUserMessage: false,
      persistReply: false,
      subagentDepth: depth + 1,
      gitWriteAuthorization: false      // escrita no GitHub não se herda
    });
  } catch (err) {
    onEvent({ type: 'status', content: `O sub-agente ${label} falhou.` });
    return { result: JSON.stringify({ error: `O sub-agente falhou: ${err.message}`, code: 'SUBAGENT_ERROR' }), usage: null };
  }
  onEvent({ type: 'status', content: `${label} concluiu a subtarefa.` });
  return {
    result: JSON.stringify(summarizeSubagentResult(result, { especialista: assistant?.name || null })),
    usage: result?.usage || null,
    stopped: Boolean(result?.stopped)
  };
}
