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
//
// AUTORIZAÇÃO NÃO SE NEGOCIA COM O MODELO. Tudo que o filho pode fazer vem de um
// `DelegationContext` IMUTÁVEL montado pelo pai (`buildDelegationContext`) a
// partir do pedido REAL do usuário: ferramentas efetivas, política de sandbox,
// rede e escrita nas Pastas do PC. O texto da subtarefa é escrito pelo modelo,
// então ele nunca pode ser fonte de permissão — sem esse contexto, um "baixe da
// API" ou "salve na pasta" inventado pelo próprio modelo abriria rede e escrita
// que o usuário nunca autorizou.

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
//
// SEMÁFORO DE VERDADE (contador + fila FIFO). A versão anterior fazia
// `Promise.race([...ativas])` para esperar vaga: com DUAS tarefas em espera, as
// duas aguardavam a MESMA corrida e a conclusão de uma única tarefa liberava as
// duas ao mesmo tempo — com limite 2 e quatro tarefas, o pico observado era 3.
// Mais chamadas simultâneas ao provedor do que o configurado significa 429, CPU
// disputada e concorrência não prevista no sandbox. Aqui cada vaga liberada
// solta EXATAMENTE uma tarefa da fila, na ordem em que entrou.
export function createSubagentLimiter(limit = maxParallelSubagents()) {
  let running = 0;
  const queue = [];
  const release = () => {
    running -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return (task) => new Promise((resolve, reject) => {
    const start = () => {
      running += 1;
      let promise;
      // Uma tarefa que lança SÍNCRONO também precisa devolver a vaga — do
      // contrário a fila trava para sempre.
      try { promise = Promise.resolve(task()); }
      catch (err) { promise = Promise.reject(err); }
      promise.then(resolve, reject);
      promise.then(release, release);
    };
    if (running < limit) start();
    else queue.push(start);
  });
}

export function subagentResultChars() {
  const configured = Number(process.env.SUBAGENT_RESULT_CHARS);
  return Number.isFinite(configured) && configured >= 1000 ? Math.floor(configured) : DEFAULT_RESULT_CHARS;
}

// Desligável por ambiente (SUBAGENTS_ENABLED=false) sem tocar no código.
export function subagentsEnabled() {
  return String(process.env.SUBAGENTS_ENABLED || '').toLowerCase() !== 'false';
}

// Quantos especialistas cabem no inventário mandado ao modelo. Acima disso a
// definição da ferramenta cresce mais do que ajuda.
const MAX_SPECIALISTS_OFFERED = 20;

const SUBAGENT_TOOL_DESCRIPTION = 'Delega uma subtarefa AUTOCONTIDA a um sub-agente com contexto próprio, que executa ferramentas e devolve só o resultado final. Use quando a subtarefa for pesada e isolável (varrer muitos arquivos, analisar um documento longo, apurar um ponto específico, testar uma hipótese) e o detalhe do caminho NÃO precisar ocupar esta conversa. Não use para pedidos curtos que você já resolve direto — delegar custa tempo e tokens. O sub-agente NÃO vê esta conversa: escreva a tarefa completa, com todos os dados necessários. Ele trabalha com as MESMAS ferramentas e as mesmas autorizações desta tarefa — delegar não amplia acesso.';

// Monta a definição da ferramenta com o INVENTÁRIO real de especialistas do
// usuário. Antes, `especialista` era texto livre pedindo "o nome exato" sem que
// o modelo soubesse quais nomes existem — na prática ele inventava "Fiscal",
// "Contábil", "Revisor", e o código caía num assistente padrão em silêncio.
// Agora o id vai como `enum`: ou o modelo escolhe um que existe, ou não escolhe.
export function subagentToolDefinitionFor(specialists = []) {
  const list = (Array.isArray(specialists) ? specialists : []).slice(0, MAX_SPECIALISTS_OFFERED);
  const properties = {
    tarefa: { type: 'string', description: 'Instrução completa e autocontida, com todo o contexto necessário (caminhos de arquivo, números, regras). O sub-agente não enxerga o histórico desta conversa.' },
    entregar: { type: 'string', description: 'O que deve voltar como resultado: um resumo, uma tabela, o caminho de um arquivo gerado, uma conclusão objetiva.' }
  };
  if (list.length) {
    const inventory = list.map(s => `${s.id} = ${s.name}`).join(' | ');
    properties.especialista_id = {
      type: 'string',
      enum: list.map(s => s.id),
      description: `(opcional) id de um assistente cadastrado, para o sub-agente usar o prompt dele. Só estes ids existem: ${inventory}. Não invente id nem nome — sem um destes, omita o campo e o sub-agente usa o mesmo perfil desta conversa.`
    };
  }
  return {
    type: 'function',
    function: {
      name: SUBAGENT_TOOL_NAME,
      description: SUBAGENT_TOOL_DESCRIPTION,
      parameters: { type: 'object', properties, required: ['tarefa'] }
    }
  };
}

// Definição sem especialistas (conta sem assistentes cadastrados, e o default
// usado pelos testes e por chamadores que não precisam do inventário).
export const subagentToolDefinition = subagentToolDefinitionFor([]);

// Inventário de especialistas oferecido ao modelo. Falha de banco não pode
// derrubar a execução: sem inventário, a delegação segue sem especialista.
export async function listSubagentSpecialists(userId) {
  if (!userId) return [];
  try {
    // O teto entra literal (é constante de código, não entrada do usuário): um
    // `LIMIT ?` deixaria o Postgres inferir o tipo de um parâmetro sem contexto.
    const rows = await db.prepare(`SELECT id, name, model FROM assistants WHERE user_id=? ORDER BY created_at ASC LIMIT ${MAX_SPECIALISTS_OFFERED}`)
      .all(userId);
    return (rows || [])
      .map(row => ({ id: String(row.id || ''), name: String(row.name || '').trim(), model: row.model || null }))
      .filter(row => row.id && row.name);
  } catch (err) {
    console.error('[subagente] inventário de especialistas indisponível:', err.message);
    return [];
  }
}

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
  const original = String(args.tarefa || '').trim();
  // Corte SILENCIOSO era o pior caso: numa instrução longa, o que se perde são
  // justamente as regras do final ("não altere X", "arredonde para baixo") — e
  // o sub-agente executava achando que tinha a instrução inteira. Agora o corte
  // é declarado, para ele saber que falta coisa e dizer isso no resultado.
  const truncated = original.length > DEFAULT_TASK_CHARS;
  const tarefa = truncated
    ? `${original.slice(0, DEFAULT_TASK_CHARS)}\n\n[TAREFA TRUNCADA: a instrução acima foi cortada em ${DEFAULT_TASK_CHARS} caracteres. Execute o que está escrito e avise no resultado que a instrução chegou incompleta.]`
    : original;
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
export function summarizeSubagentResult(result, { especialista = null, modelo = null, limit = null } = {}) {
  if (!result) return { ok: false, error: 'O sub-agente não retornou resultado.', code: 'SUBAGENT_EMPTY' };
  if (result.stopped) return { ok: false, error: 'Execução interrompida pelo usuário.', code: 'CANCELED' };
  const max = limit || subagentResultChars();
  const texto = String(result.text || '').trim();
  return {
    ok: !result.incomplete && !result.providerFailure,
    // Quem REALMENTE executou. Sem isso, o pai (e a interface) não tinham como
    // saber se o especialista pedido foi mesmo o que rodou.
    ...(especialista ? { especialista } : {}),
    ...(modelo ? { modelo } : {}),
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

// Busca o assistente pelo id (caminho novo, vindo do `enum` da ferramenta) ou
// pelo nome exato (compatibilidade com o parâmetro antigo). Sem match devolve
// null e quem chama RECUSA a delegação: o fallback silencioso para o assistente
// padrão fazia a interface anunciar "Delegando para Fiscal" enquanto rodava o
// assistente geral com o modelo do pai — uma mentira difícil de perceber.
export async function findSubagentAssistant(userId, ref) {
  const wanted = String(ref || '').trim();
  if (!userId || !wanted) return null;
  try {
    const row = await db.prepare('SELECT * FROM assistants WHERE user_id=? AND (id=? OR lower(name)=lower(?)) ORDER BY created_at ASC LIMIT 1')
      .get(userId, wanted, wanted);
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

// Lançar as delegações do lote em paralelo só é seguro quando o lote NÃO tem
// mais nada. Num lote misto (`write_file` + `delegar_subagente` para revisar o
// arquivo), o filho partia antes da escrita acontecer. Pura de propósito: é o
// ponto testável da regra de ordem.
export function canLaunchDelegationsInParallel(toolCallNames = []) {
  const names = Array.isArray(toolCallNames) ? toolCallNames : [];
  if (!names.length) return false;
  return names.every(name => name === SUBAGENT_TOOL_NAME);
}

// ---- DelegationContext: o que o filho herda, e SÓ o que ele herda ----

// Objeto congelado, montado uma única vez pelo pai a partir do pedido real do
// usuário. É a fronteira de autorização da árvore de execução inteira: o filho
// não recalcula nada disto a partir do texto da subtarefa (que o modelo
// escreveu) nem cai no conjunto padrão de ferramentas.
export function buildDelegationContext({
  assistant = null,
  toolNames = [],
  sandboxOptions = {},
  developerContext = null,
  networkEnabled = false,
  pcWriteAuthorized = false
} = {}) {
  const allowedToolNames = Object.freeze([...new Set(
    (Array.isArray(toolNames) ? toolNames : [])
      .map(name => String(name || ''))
      // Delegar de dentro de uma delegação já é barrado pela profundidade; tirar
      // o nome daqui evita que a interseção o reintroduza.
      .filter(name => name && name !== SUBAGENT_TOOL_NAME)
  )]);
  return Object.freeze({
    assistant,                                    // perfil do pai, quando não há especialista
    allowedToolNames,
    sandboxOptions: Object.freeze({ ...sandboxOptions }),
    developerContext,
    networkEnabled: Boolean(networkEnabled),
    pcWriteAuthorized: Boolean(pcWriteAuthorized),
    gitWriteAuthorized: false                     // escrita no GitHub nunca se herda
  });
}

// Interseção pai ∩ especialista. O filho monta a lista dele normalmente (perfil
// do especialista, web, github) e ela é PODADA por esta lista. Sem isto, um
// assistente somente-leitura que delegasse ganhava, no filho, `bash`,
// `run_python` e `write_file` — escalada de permissão entre assistentes.
export function intersectToolDefinitions(tools = [], allowedToolNames = null) {
  if (!Array.isArray(allowedToolNames)) return tools;
  const allowed = new Set(allowedToolNames);
  return (tools || []).filter(tool => allowed.has(tool?.function?.name));
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
  delegation = null,
  runner = null
}) {
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return { result: JSON.stringify({ error: 'Um sub-agente não pode delegar para outro sub-agente. Execute a subtarefa você mesmo.', code: 'SUBAGENT_DEPTH' }), usage: null };
  }
  const tarefa = String(args.tarefa || '').trim();
  if (!tarefa) {
    return { result: JSON.stringify({ error: 'Descreva a subtarefa no parâmetro "tarefa".', code: 'SUBAGENT_EMPTY_TASK' }), usage: null };
  }

  // Especialista PEDIDO x especialista ENCONTRADO. Pedir um que não existe é
  // erro de ferramenta, não motivo para trocar por outro em silêncio.
  const requested = String(args.especialista_id || args.especialista || '').trim();
  let assistant = delegation?.assistant || null;
  if (requested) {
    assistant = await findSubagentAssistant(userId, requested);
    if (!assistant) {
      const disponiveis = await listSubagentSpecialists(userId);
      return {
        result: JSON.stringify({
          error: `Não existe assistente cadastrado com id ou nome "${requested}".`,
          code: 'SUBAGENT_SPECIALIST_NOT_FOUND',
          especialistas_validos: disponiveis.map(item => `${item.id} = ${item.name}`),
          dica: 'Escolha um id da lista ou omita o campo para o sub-agente usar o mesmo perfil desta conversa.'
        }),
        usage: null
      };
    }
  }
  const label = assistant?.name || 'sub-agente';
  const modelo = assistant?.model || model || null;
  const runAgent = runner || await loadRunAgent();

  onEvent({ type: 'status', content: `Delegando para ${label}...` });
  let result;
  try {
    result = await runAgent({
      userId,
      conversationId,                   // mesmo workspace/sandbox do pai
      userText: buildSubagentTask(args),
      model: modelo,
      assistant,
      webSearch,
      effort: subagentEffort(effort),
      control,                          // herda pausar/parar do pai
      onEvent: subagentEventForwarder(onEvent, label, delegationId),
      saveUserMessage: false,
      persistReply: false,
      subagentDepth: depth + 1,
      gitWriteAuthorization: false,     // escrita no GitHub não se herda
      delegation                        // permissões, sandbox e escopo do pai
    });
  } catch (err) {
    onEvent({ type: 'status', content: `O sub-agente ${label} falhou.` });
    return { result: JSON.stringify({ error: `O sub-agente falhou: ${err.message}`, code: 'SUBAGENT_ERROR' }), usage: null };
  }
  onEvent({ type: 'status', content: `${label} concluiu a subtarefa.` });
  return {
    result: JSON.stringify(summarizeSubagentResult(result, { especialista: assistant?.name || null, modelo })),
    usage: result?.usage || null,
    stopped: Boolean(result?.stopped)
  };
}
