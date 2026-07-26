// Loop do agente (runAgent): a conversa de agente único, com streaming,
// ferramentas, reparos, failover de modelo e entrega de arquivos.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import { getUserProvider } from '../userProvider.js';
import { rawModelId } from '../modelRef.js';
import { freeTierConfigured } from '../freeTier.js';
import { nanoid } from 'nanoid';
import { webToolDefinitions, runTool } from '../tools.js';
import { buildContext, historyBudgetForModel, selectHistoryForContext } from '../memory/contextBuilder.js';
import { upsertProject, linkConversationToProject, projectIdForConversation, adoptConversations } from '../memory/projectStore.js';
import { indexAfterReply } from '../memory/indexer.js';
import { getSettings } from '../memory/memoryService.js';
import { isLowSignalTurn, LOW_SIGNAL_TURN_NOTE } from '../memory/retrievalPolicy.js';
import { buildModelRuntimeState, isUnsupportedToolError, isUnsupportedVisionError, isModelUnavailableError, isToolChoiceReasoningConflictError, markModelCapabilityUnsupported, modelCompatibilityMessage } from '../modelCapabilities.js';
import { createToolProtocolStreamGuard, parseTextToolCalls, sanitizeToolProtocolText } from '../toolProtocol.js';
import { githubToolDefinitions, GITHUB_WRITE_TOOLS, hasGithubConnection } from '../connectors/github.js';
import { effortCfg, promptFor, promptManifestFor, toolsFor, temperatureFor, developerContextFor, toolAvailabilityNote, ENVIRONMENT_QUERY_RE, verifiedEnvironmentNote, pcFoldersNote, uploadsNote, clipForBriefing, BRIEFING_CHAR_LIMIT, QUALITY_BAR } from './prompts.js';
import { listOutputs, mentionsOutputPath, recoverAlternateOutputs, referencedOutputFiles, fileSignature, validateOutputs } from './outputs.js';
import { OUTPUT_DELIVERY_REPAIR_NOTE, MISSING_OUTPUT_NOTICE, EXECUTION_COMPLETION_REPAIR_NOTE, EXECUTION_INCOMPLETE_NOTICE, TOOL_PROTOCOL_REPAIR_NOTE, TOOL_PROTOCOL_FAILURE_NOTICE, RESPONSE_TRUNCATED_REPAIR_NOTE, RESPONSE_TRUNCATED_NOTICE, EXECUTION_CONTRACT_NOTE, MACRO_REQUEST_RE, MACRO_LIMITATION_NOTE, DEGEN_CHECK_STEP, looksDegenerate, shouldRepairOutputDelivery, shouldRepairExecution, shouldContinueAfterTruncation, materializeTextOutput, endsAwaitingUserReply } from './repair.js';
import { normalizeWebFetchUrl, classifyToolOutcome, webResearchStopReason, planToolCallBatch, WEB_TOOL_NAMES, webResearchFinalizationNote, WEB_RESEARCH_FETCH_LIMIT, TOOL_CALLS_PER_STEP_LIMIT } from './webResearch.js';
import { imageUploadParts, attachImagesToLastUserMessage, stripImagePartsFromMessages } from './vision.js';
import { STREAM_RECOVERY_LIMIT, STREAM_RESUME_NOTE, STREAM_PAUSE_RESUME_NOTE, PROVIDER_TIMEOUT_NOTICE, isRetryableStreamError, openRouterRouting, retryDelay, addUsage, applyPromptCache, clearPromptCache, tagProviderError } from './provider.js';
import { guardStreamStall, PROVIDER_CONNECT_TIMEOUT_MS } from './streamGuard.js';
import { acquireConversationControl, releaseConversationControl, beginProviderRequest, releaseProviderRequest, beginToolRequest, releaseToolRequest, controlInterruptReason, gate } from './control.js';
import { clientScopeFor, memoryNote, saveMessage, persistAssistantReply } from './persistence.js';
import { saveCheckpoint, clearCheckpoint, isResumableReason, buildResumeMessages, leadingSystemCount, trimCheckpointMessages, AUTO_CONTINUE_NOTE } from './checkpoint.js';
import { untrustedContext } from './promptRegistry.js';
import { emitExecutionState, finalExecutionState } from './executionState.js';
import { resolveSandboxNetwork, isToolCallAllowed } from './assistantPolicy.js';
import { explicitlyAuthorizesPcWrite } from '../execGuard.js';
import { SUBAGENT_TOOL_NAME, subagentToolDefinition, shouldOfferSubagentTool, maxSubagentsPerRun, createSubagentLimiter, runSubagent } from './subagents.js';
import { buildDocumentContext, DOC_PRECEDENCE_NOTE } from '../docling/context.js';
import { doclingImageParts, visualElementsNote } from '../docling/vision.js';

export function explicitlyAuthorizesGitWrite(text) {
  const value = String(text || '');
  return /\b(?:fa(?:ça|ca)|crie|abra|envie|publique|suba|realize)\b[^\n.]{0,80}\b(?:commit|push|pull request|pr)\b/i.test(value)
    || /\b(?:commit|push|pull request)\b[^\n.]{0,80}\b(?:github|reposit[oó]rio|branch)\b/i.test(value)
    || /^\s*(?:git\s+)?(?:commit|push|pull request|pr)\b/i.test(value);
}

export function buildProviderRequest({ model, messages, tools = [], forceNativeToolCall = false, reasoningEffort = null, reasoningParameter = 'reasoning', temperature = 0.3, acceptsTemperature = true, baseURL } = {}) {
  return {
    model,
    messages,
    ...(tools.length ? { tools, tool_choice: forceNativeToolCall ? 'required' : 'auto' } : {}),
    ...(reasoningEffort
      ? (reasoningParameter === 'reasoning_effort' ? { reasoning_effort: reasoningEffort } : { reasoning: { effort: reasoningEffort } })
      : {}),
    ...(acceptsTemperature ? { temperature } : {}),
    ...openRouterRouting(tools.length > 0, baseURL),
    stream: true,
    stream_options: { include_usage: true }
  };
}

export function buildOutputBaseline(files = [], { acceptAll = false, continuationPaths = [] } = {}) {
  if (acceptAll) return new Map();
  const accepted = new Set((continuationPaths || []).map(value => String(value || '')));
  return new Map(files
    .filter(file => !accepted.has(String(file?.path || '')))
    .map(file => [file.path, fileSignature(file)]));
}

// RETOMADA REAL (checkpoint): `resume` (quando presente) traz o estado salvo de
// um run interrompido — array de mensagens do agente, modelo ativo, cadeia de
// failover já tentada e o objetivo. Com ele, o loop CONTINUA de onde parou (com
// orçamento de ciclos NOVO), em vez de recomeçar do zero. Ver checkpoint.js.
export async function runAgent({ userId, conversationId, userText, model, assistant, webSearch, effort, developer, onEvent, saveUserMessage = true, existingUserMessageId = null, executionBriefing = null, forceExecution = false, control: inheritedControl = null, resume = null, gitWriteAuthorization = null, persistReply = true, continuationOutputPaths = [], subagentDepth = 0 }) {
  // Execução DELEGADA (sub-agente): compartilha a conversa e o workspace com o
  // pai, mas não é dona da conversa — não grava mensagem, não grava checkpoint
  // e não delega de novo. Quem responde ao usuário e é retomável é o pai.
  const isSubagent = subagentDepth > 0;
  const requestedModel = resume?.model || model || assistant?.model || '';
  const provider = await getUserProvider(userId, requestedModel); // chave dona do modelo
  const client = provider.client;                          // sombreia o cliente global
  const runId = resume?.runId || nanoid();
  // No resume, o modelo ativo é o que estava rodando quando parou (pode ser um
  // de reserva já acionado) — não voltamos ao modelo original.
  let chosenModel = requestedModel && requestedModel.includes('::') ? requestedModel : (provider.modelRef || requestedModel);
  // MODO GRATUITO: o modelo precisa estar na allowlist gratuita — a chave da
  // plataforma nunca atende um modelo pago escolhido no seletor. Fora da lista,
  // cai no modelo gratuito padrão.
  if (provider.source === 'free' && !(provider.freeModels || []).includes(chosenModel)) {
    chosenModel = provider.modelRef;
  }
  // Modelo com que a tarefa COMEÇA. Se um failover trocar de modelo no meio da
  // execução, comparamos o modelo final com este para registrar a troca NA
  // PRÓPRIA RESPOSTA — uma substituição de modelo nunca pode passar despercebida
  // (foi exatamente a queixa que originou esta mudança: o usuário só percebeu a
  // troca depois que a tarefa terminou).
  const startedModel = chosenModel;
  // FAILOVER (MM-04): se o provedor cair no meio da tarefa, antes o app só
  // repetia o MESMO modelo e desistia. Agora há uma cadeia de reserva — os
  // modelos de MODEL_FALLBACKS (env), os modelos gratuitos alternativos (modo
  // gratuito) e, por padrão, o modelo-base da conta — acionada só quando o
  // modelo escolhido falha de forma recuperável, sem perder o trabalho já feito
  // (as mensagens/ferramentas já executadas ficam).
  const fallbackChain = [
    ...(provider.source === 'free' ? [] : String(process.env.MODEL_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean)),
    ...(provider.fallbackModels || []),
    ...(provider.modelRef && provider.modelRef !== chosenModel ? [provider.modelRef] : [])
  ];
  // No resume, preserva a cadeia de failover já tentada (não retenta modelos
  // que já falharam nesta tarefa).
  const triedModels = new Set(resume?.triedModels?.length ? resume.triedModels : [chosenModel]);
  const nextFallbackModel = () => {
    for (const m of fallbackChain) if (m && !triedModels.has(m)) { triedModels.add(m); return m; }
    return null;
  };
  const chosenPrompt = promptFor(assistant);
  const eff = effortCfg(effort);
  // Conexão do GitHub consultada UMA vez: alimenta tanto a nota do modo
  // desenvolvedor (para não instruir o clone quando não há conexão) quanto o
  // gate das ferramentas github_* mais abaixo.
  const githubConnected = await hasGithubConnection(userId);
  const gitWriteAuthorized = gitWriteAuthorization == null
    ? explicitlyAuthorizesGitWrite(userText)
    : Boolean(gitWriteAuthorization);
  const developerContext = developerContextFor(developer, userId, { githubConnected, gitWriteAuthorized });
  // Projeto do Modo Desenvolvedor: espelha o projeto do navegador no servidor e
  // carimba a conversa. Sem este vínculo, o Context Builder não consegue
  // priorizar "as últimas conversas deste projeto" num chat novo — que é o que
  // quebrava a continuidade.
  let activeProjectId = await projectIdForConversation(userId, conversationId);
  try {
    if (developer?.project?.id) {
      const saved = await upsertProject(userId, developer.project);
      if (saved) {
        // Histórico que o navegador já associava ao projeto entra de uma vez.
        if (Array.isArray(developer.project.conversationIds)) {
          await adoptConversations(userId, saved.id, developer.project.conversationIds);
        }
        if (await linkConversationToProject(userId, conversationId, saved.id)) activeProjectId = saved.id;
      }
    } else if (developer?.devProjectId) {
      if (await linkConversationToProject(userId, conversationId, developer.devProjectId)) activeProjectId = developer.devProjectId;
    }
  } catch (err) {
    console.error('[memória] vínculo do projeto falhou (segue sem):', err.message);
  }
  const lowSignalTurn = isLowSignalTurn(userText);
  // A política persistente (Configurações → Sandbox e rede) decide o padrão:
  // automático (só quando o pedido pede), sempre ligada ou sempre desligada.
  // Não toca nas chamadas dos modelos — essas saem do backend.
  const sandboxNetworkEnabled = !lowSignalTurn && (resume
    ? Boolean(resume?.meta?.sandboxNetworkEnabled)
    : resolveSandboxNetwork(getSettings().sandbox_network_policy, userText));
  const promptManifest = promptManifestFor(assistant, developerContext ? ['developer'] : []);
  // ESCRITA nas Pastas do PC (arquivos REAIS e insubstituíveis do usuário).
  // No Modo Desenvolvedor, escolher um projeto gravável + um modo de escrita JÁ
  // é a autorização, e ela é escopada àquela pasta. No chat comum, a decisão é
  // do backend a partir do pedido DESTE turno — igual à rede do sandbox. Sem
  // pedido explícito, as pastas são montadas somente-leitura (garantia do
  // Docker, não só do prompt).
  const pcWriteAuthorized = !lowSignalTurn && (developerContext
    ? !developerContext.readOnlyProject
    : explicitlyAuthorizesPcWrite(userText));
  // userId viaja junto: o sandbox monta só as pastas do PC DESTE usuário
  // (isolamento multi-tenant) e aplica o limite de sandboxes por usuário.
  const sandboxOptions = {
    ...(developerContext?.sandboxOptions || { readOnlyPc: !pcWriteAuthorized }),
    userId,
    model: chosenModel,
    networkEnabled: sandboxNetworkEnabled,
    pcWriteAuthorized
  };
  const webSearchActive = Boolean(webSearch && !lowSignalTurn);
  let requestedTools = toolsFor(assistant);
  if (developerContext?.readOnlyProject) requestedTools = requestedTools.filter(tool => !['write_file', 'zip_outputs', 'generate_image'].includes(tool.function.name));
  if (webSearchActive) requestedTools = [...requestedTools, ...webToolDefinitions];
  // Conector GitHub: as ferramentas github_* só são oferecidas a quem conectou
  // a conta (Configurações → Conectores). Em plan/review, as de escrita
  // (push/PR) ficam de fora — esses modos não alteram nada.
  if (!lowSignalTurn && githubConnected) {
    // Em modo desenvolvedor de leitura (ask/plan/review), as ferramentas de
    // escrita do GitHub (push/PR) ficam de fora — esses modos não alteram nada.
    const githubTools = (!developerContext?.canWrite || !gitWriteAuthorized)
      ? githubToolDefinitions.filter(tool => !GITHUB_WRITE_TOOLS.has(tool.function.name))
      : githubToolDefinitions;
    requestedTools = [...requestedTools, ...githubTools];
  }
  if (lowSignalTurn) requestedTools = [];
  // SUB-AGENTES: a ferramenta de delegação só é oferecida quando delegar faz
  // sentido — há ferramentas na mesa, não é um turno social, não estamos já
  // dentro de um sub-agente e a conta não está no modo gratuito (ver os
  // guard-rails em subagents.js).
  const subagentsOffered = shouldOfferSubagentTool({
    depth: subagentDepth,
    lowSignalTurn,
    providerSource: provider.source,
    hasTools: requestedTools.length > 0
  });
  if (subagentsOffered) requestedTools = [...requestedTools, subagentToolDefinition];
  const subagentBudget = maxSubagentsPerRun();
  // Teto de delegações SIMULTÂNEAS (as do mesmo lote correm em paralelo).
  const delegationSlot = createSubagentLimiter();
  let subagentRuns = 0;

  const uploadNoteForRun = !lowSignalTurn ? uploadsNote(userId, conversationId) : null;
  // Docling: quando ligado e houver documentos já processados nesta conversa,
  // injeta o CONTEÚDO pré-extraído (Markdown otimizado / chunks relevantes com
  // página) — mesma extração para todos os modelos, sem re-extrair por modelo.
  // Se estiver desligado ou nada tiver sido processado, docContext é null e o
  // fluxo segue idêntico ao atual (fallback, sem regressão).
  let docContext = null;
  if (!lowSignalTurn) {
    try { docContext = await buildDocumentContext(userId, conversationId, { query: userText }); }
    catch (e) { console.error('[docling] contexto falhou:', e.message); }
  }

  const modelPlanInput = () => ({
    modelId: chosenModel,
    tools: requestedTools,
    userText,
    webSearch: webSearchActive,
    developer: Boolean(developerContext && !lowSignalTurn),
    hasUploads: Boolean(uploadNoteForRun),
    reasoningEffort: eff.reasoning
  });
  let modelRuntime = buildModelRuntimeState(modelPlanInput());
  let modelPlan = modelRuntime.plan;
  let tools = modelRuntime.tools;
  let reasoningEffort = modelRuntime.reasoningEffort;
  const temperature = temperatureFor(assistant?.personality);
  const control = inheritedControl || acquireConversationControl(conversationId, userId);
  const ownsControl = !inheritedControl;
  try {
  // No resume NÃO gravamos uma nova mensagem de usuário — o objetivo já está na
  // conversa e no checkpoint (evita duplicar o pedido e criar execução nova).
  // Sub-agente NÃO grava a mensagem de usuário: o pedido dele é uma instrução
  // interna do agente principal, não uma fala da pessoa na conversa.
  const userMsgId = isSubagent
    ? null
    : (resume
        ? (existingUserMessageId || null)
        : (saveUserMessage || !existingUserMessageId
            ? await saveMessage(userId, conversationId, 'user', userText)
            : existingUserMessageId));
  emitExecutionState(onEvent, developerContext ? 'planning' : 'analyzing', resume ? 'Retomando do checkpoint seguro' : 'Preparando a execução', { runId });

  // BYOK: sem chave de API configurada, orienta a cadastrar e encerra.
  if (!provider.hasKey) {
    const finalText = freeTierConfigured()
      ? 'Nenhuma chave de API configurada. Você pode **começar gratuitamente** (Configurações → Provedor de IA → "Começar gratuitamente") ou cadastrar a sua própria chave (OpenRouter/DeepSeek) para conversar.'
      : 'Nenhuma chave de API configurada. Vá em **Configurações → Provedor de IA** e cadastre a sua chave (OpenRouter/DeepSeek) para começar a conversar.';
    onEvent({ type: 'status', content: 'Chave de API não configurada' });
    onEvent({ type: 'delta', content: finalText });
    const execution = emitExecutionState(onEvent, 'awaiting_user', 'Configuração do provedor necessária', { runId });
    if (!isSubagent) {
      const assistantMessageId = await saveMessage(userId, conversationId, 'assistant', finalText, { executionMeta: execution });
      onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId });
    }
    return { text: finalText, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, model: chosenModel, stopped: false, ...(isSubagent ? { incomplete: true, failureMessage: 'Provedor sem chave para o modelo do sub-agente.' } : {}) };
  }

  if (modelPlan.blocked) {
    const finalText = modelCompatibilityMessage(modelPlan);
    const status = modelPlan.blocked.capability === 'tools'
      ? 'Este modelo nao executa ferramentas.'
      : 'Este modelo nao responde em texto.';
    onEvent({ type: 'status', content: status });
    onEvent({ type: 'delta', content: finalText });
    const execution = emitExecutionState(onEvent, 'fatal_error', status, { runId, compatibility: modelPlan.blocked.capability });
    if (!isSubagent) {
      const assistantMessageId = await saveMessage(userId, conversationId, 'assistant', finalText, { executionMeta: execution });
      onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId });
      indexAfterReply(userId, conversationId).catch(() => {});
    }
    return {
      text: finalText,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model: chosenModel,
      stopped: false,
      compatibility: modelPlan.blocked.capability,
      ...(isSubagent ? { incomplete: true, failureMessage: status } : {})
    };
  }
  let environmentNote = null;
  if (ENVIRONMENT_QUERY_RE.test(String(userText || '')) && tools.some(tool => tool.function.name === 'bash')) {
    onEvent({ type: 'status', content: 'Conferindo o ambiente real...' });
    environmentNote = await verifiedEnvironmentNote(conversationId, userText, tools, sandboxOptions);
  }
  // Economia de tokens: menos mensagens de histórico consideradas por resposta
  const historyLimit = getSettings().economy_mode ? 20 : Number(process.env.AGENT_HISTORY_LIMIT || 60);
  const includeEnvironmentInventory = Boolean(developerContext) || ENVIRONMENT_QUERY_RE.test(String(userText || ''));
  // MENSAGENS SYSTEM CONSOLIDADAS: o app roda modelos heterogêneos via
  // OpenRouter e vários tratam mal uma pilha de mensagens "system" (alguns só
  // honram a primeira). O preâmbulo usa então POUCAS mensagens, alinhadas aos
  // breakpoints do prompt caching:
  //   [0] prompt-base + QUALITY_BAR — estável na conversa inteira (breakpoint 1);
  //   [1] nota de ferramentas — índice RESERVADO, reescrito adiante quando as
  //       ferramentas mudam (fallback sem tools, fim da pesquisa web);
  //   depois, os dados não confiáveis (role user, com untrustedContext) e UMA
  //   mensagem com as notas de sistema desta chamada, fechando o prefixo
  //   estático (breakpoint 2 cai sobre ela por ser a última e ser system).
  const messages = [
    { role: 'system', content: `${chosenPrompt}\n\n${QUALITY_BAR}` },
    { role: 'system', content: toolAvailabilityNote(tools, { includeInventory: includeEnvironmentInventory, sandboxNetworkEnabled }) }
  ];
  if (executionBriefing) messages.push({ role: 'user', content: untrustedContext('team-briefing', clipForBriefing(String(executionBriefing), BRIEFING_CHAR_LIMIT)) });
  if (environmentNote) messages.push({ role: 'user', content: untrustedContext('verified-environment-output', environmentNote) });
  if (developerContext?.userRules) messages.push({ role: 'user', content: untrustedContext('project-rules', developerContext.userRules) });
  const callNotes = [];
  if (forceExecution || modelPlan.requirements.required) callNotes.push(EXECUTION_CONTRACT_NOTE);
  if (MACRO_REQUEST_RE.test(String(userText || ''))) callNotes.push(MACRO_LIMITATION_NOTE);
  if (lowSignalTurn) callNotes.push(LOW_SIGNAL_TURN_NOTE);
  if (developerContext) callNotes.push(developerContext.note);
  if (eff.nudge) callNotes.push(eff.nudge);
  if (webSearchActive) callNotes.push(`PESQUISA NA INTERNET — o usuário ativou a busca. Você tem acesso real à web, pelas ferramentas web_search (procurar) e web_fetch (abrir uma página). Nunca diga que "não tem acesso à internet".

Pense antes de buscar: eu já sei isso com confiança e é algo que não muda com o tempo? Então responda direto — não pesquise por pesquisar. Busque quando a resposta depender de algo atual, externo ou verificável (legislação, prazos, tabelas, cotações, notícias, dados de uma empresa/produto) ou quando tiver dúvida.

Ao pesquisar, aja como uma pessoa atenta faria:
- Diga em UMA linha curta e no seu tom o que vai olhar — ex.: "Deixa eu conferir isso numa fonte atual." Varie as palavras; não repita a mesma frase nem narre cada consulta.
- Monte buscas específicas (termos exatos, ano, órgão, cidade). Se a primeira vier fraca, refine em vez de repetir. Abra cada página no máximo uma vez.
- Leia de verdade as páginas relevantes com web_fetch antes de afirmar algo; não confie apenas no resuminho da busca.

Ao trazer o que encontrou:
- Sintetize com suas palavras e mostre como chegou à conclusão. NÃO cole uma lista de links soltos.
- Se as fontes divergirem, diga isso e aponte qual é mais confiável (site oficial > blog) e por quê.
- Cite a fonte no meio do texto (nome + link) para o usuário conferir; prefira fontes oficiais e recentes e avise quando algo estiver incerto ou desatualizado.
- Varie a forma de apresentar: evite começar sempre com "De acordo com a pesquisa…".

O globo libera web_search/web_fetch pelo backend, mas não abre automaticamente a rede direta do sandbox. Para CNPJ, use a ferramenta consultar_cnpj.`);
  if (callNotes.length) messages.push({ role: 'system', content: callNotes.join('\n\n') });
  // Fim do preâmbulo ESTÁVEL (prompt-base + notas de sistema): tudo daqui pra
  // frente (memória, uploads, histórico) muda a cada turno. É o ponto natural
  // para o breakpoint de prompt caching.
  const staticPrefixEnd = messages.length;
  let memoryMeta = null;
  // Memória de longo prazo: perfil, notas, resumos e recuperação semântica
  try {
    // developerDomain: estar em modo desenvolvedor (com projeto/repositório) é
    // um fato estrutural sobre o assunto da conversa. Sem ele, um pedido curto
    // como "vamos continuar o projeto" não tem domínio nenhum e o crivo de
    // memória se desliga, trazendo o perfil contábil inteiro para dentro de uma
    // conversa de software.
    const contextPlan = await buildContext({ userId, conversationId, assistantId: assistant?.id, clientScope: await clientScopeFor(userId, conversationId), userText, historyLimit, model: chosenModel, developerDomain: developerContext ? 'software' : null, projectId: activeProjectId });
    const ctxBlocks = contextPlan.blocks || [];
    memoryMeta = contextPlan.meta || null;
    for (const b of ctxBlocks) {
      const clean = sanitizeToolProtocolText(b);
      if (clean) messages.push({ role: 'user', content: untrustedContext('memory', clean) });
    }
  } catch (err) {
    console.error('[memória] contexto indisponível nesta resposta:', err.message);
    const memory = await memoryNote(userId, assistant?.id, await clientScopeFor(userId, conversationId));
    const cleanMemory = sanitizeToolProtocolText(memory);
    if (cleanMemory) messages.push({ role: 'user', content: untrustedContext('memory-fallback', cleanMemory) });
  }
  if (uploadNoteForRun) messages.push({ role: 'system', content: uploadNoteForRun });
  if (docContext?.note) {
    // Ponte entre as duas instruções: a uploadsNote (acima) manda extrair com
    // ferramentas; para os documentos JÁ processados vale o conteúdo pré-
    // extraído. A nota de precedência evita as ordens contraditórias.
    if (uploadNoteForRun) messages.push({ role: 'system', content: DOC_PRECEDENCE_NOTE });
    messages.push({ role: 'user', content: untrustedContext('document-content', docContext.note) });
  }
  // ELEMENTOS VISUAIS (gráficos/assinaturas/selos): nota transparente adaptada à
  // visão do modelo. Com visão, as imagens são anexadas mais abaixo; sem visão,
  // o modelo é avisado para NÃO fingir que interpretou o elemento.
  if (docContext?.pictures?.length) {
    const vnote = visualElementsNote(docContext.pictures, modelPlan.capabilities?.vision === true);
    if (vnote) messages.push({ role: 'system', content: vnote });
  }
  const pcNote = pcFoldersNote(sandboxOptions);
  if (pcNote) messages.push({ role: 'system', content: pcNote });
  const historyPlan = await selectHistoryForContext({
    conversationId,
    limit: historyLimit,
    budgetTokens: historyBudgetForModel(chosenModel, memoryMeta?.budget)
  });
  if (memoryMeta) {
    memoryMeta = { ...memoryMeta, history: historyPlan.meta };
    onEvent({ type: 'memory_context', memory: memoryMeta });
  }
  const history = historyPlan.rows;
  messages.push(...history
    .map(m => ({
      role: m.role,
      content: m.role === 'assistant' ? sanitizeToolProtocolText(m.content) : m.content
    }))
    .filter(m => String(m.content || '').trim()));

  // RETOMADA: descarta o contexto recém-montado e usa o ESTADO SALVO do run
  // interrompido. O array do checkpoint já traz objetivo, plano, tool_calls,
  // resultados de ferramenta, erros e texto parcial — o modelo continua da
  // próxima etapa pendente, sem repetir o trabalho já feito.
  let resumePrefixEnd = staticPrefixEnd;
  if (resume) {
    const seeded = buildResumeMessages(resume.messages, { streamResumeNote: STREAM_RESUME_NOTE, objective: resume.objective });
    messages.length = 0;
    for (const m of seeded) messages.push(m);
    resumePrefixEnd = leadingSystemCount(messages);
  }

  // VISÃO MULTIMODAL: se o modelo escolhido tem visão e há imagens anexadas,
  // envia as imagens direto para o modelo (ele enxerga). Modelos SEM visão não
  // recebem as imagens aqui — continuam lendo por OCR no sandbox. No resume as
  // imagens já estão no array do checkpoint (não reanexar).
  let visionApplied = false;
  if (!resume && modelPlan.capabilities?.vision === true) {
    // Imagens dos uploads + figuras/gráficos extraídos pelo Docling (quando o
    // documento foi processado) — o modelo com visão enxerga ambos.
    const visualParts = [...imageUploadParts(userId, conversationId), ...doclingImageParts(docContext?.pictures || [])];
    visionApplied = attachImagesToLastUserMessage(messages, visualParts);
    if (visionApplied) onEvent({ type: 'status', content: 'Enviando a imagem para o modelo analisar...' });
  }

  const activateModel = (nextModel) => {
    const candidateRuntime = buildModelRuntimeState({ ...modelPlanInput(), modelId: nextModel });
    const candidatePlan = candidateRuntime.plan;
    if (candidatePlan.blocked) return { ok: false, plan: candidatePlan };
    clearPromptCache(messages);
    chosenModel = nextModel;
    modelRuntime = candidateRuntime;
    modelPlan = candidatePlan;
    tools = candidateRuntime.tools;
    reasoningEffort = candidateRuntime.reasoningEffort;
    toolFallbackApplied = false;
    forceNativeToolCall = mustInspectUploads && executedToolCalls === 0;
    messages[1] = { role: 'system', content: toolAvailabilityNote(tools, { includeInventory: includeEnvironmentInventory, sandboxNetworkEnabled }) };
    if (!resume) {
      if (candidatePlan.capabilities?.vision === true) {
        visionApplied = attachImagesToLastUserMessage(messages, imageUploadParts(userId, conversationId));
      } else {
        stripImagePartsFromMessages(messages);
        visionApplied = false;
      }
    }
    applyPromptCache(messages, chosenModel, resumePrefixEnd, provider.baseURL);
    return { ok: true, plan: candidatePlan };
  };
  const activateNextFallback = () => {
    for (let candidate = nextFallbackModel(); candidate; candidate = nextFallbackModel()) {
      const activated = activateModel(candidate);
      if (activated.ok) return candidate;
      onEvent({ type: 'status', content: `O modelo de reserva ${candidate} não atende às capacidades desta tarefa; procurando outro...` });
    }
    return null;
  };

  // Prompt caching: marca o prefixo estável para o provedor reaproveitá-lo nos
  // próximos passos/mensagens (economia de tokens de entrada + latência). No-op
  // quando o modelo/rota não suporta (ex.: DeepSeek direto já cacheia sozinho).
  applyPromptCache(messages, chosenModel, resumePrefixEnd, provider.baseURL);
  onEvent({ type: 'prompt_meta', prompt: promptManifest });

  // Usage: no resume, soma sobre o que já foi consumido no run anterior.
  const usage = {
    prompt_tokens: resume?.usage?.prompt_tokens || 0,
    completion_tokens: resume?.usage?.completion_tokens || 0,
    total_tokens: resume?.usage?.total_tokens || 0,
    cached_tokens: resume?.usage?.cached_tokens || 0
  };
  // Orçamento de etapas do loop agêntico. Cada etapa = um turno do modelo (que
  // costuma executar UMA ferramenta), então tarefa longa/programação consome
  // muitas etapas de trabalho legítimo.
  // 1) AGENT_MAX_STEPS é PISO, nunca teto que reduza o esforço escolhido:
  //    escolher "Máx" precisa valer ao menos os passos do esforço, mesmo com
  //    AGENT_MAX_STEPS=30 no .env. (Antes o env sobrescrevia e cortava para 30 em
  //    silêncio — por isso "aumentar o limite no código" nunca pegava.)
  // 2) Modo desenvolvedor é programação por natureza: orçamento bem maior
  //    (AGENT_DEV_MAX_STEPS, padrão 200).
  const envSteps = Number(process.env.AGENT_MAX_STEPS) || 0;
  let maxSteps = Math.max(eff.steps, envSteps);
  if (developerContext) maxSteps = Math.max(maxSteps, Number(process.env.AGENT_DEV_MAX_STEPS) || 200);
  // Teto absoluto de segurança contra loop infinito. Uma tarefa que AINDA está
  // rendendo (ferramenta executada com sucesso há poucas etapas) pode passar do
  // orçamento base até este teto, em vez de ser abortada no meio do trabalho.
  const hardMaxSteps = Math.max(maxSteps, Number(process.env.AGENT_HARD_MAX_STEPS) || Math.round(maxSteps * 1.5));
  const IDLE_STEP_GRACE = 2; // etapas sem progresso toleradas após o orçamento base
  let lastProductiveStep = 0;
  // 3) FÔLEGO AUTOMÁTICO: bater o teto AINDA TRABALHANDO deixou de ser erro.
  //    O teto vale por JANELA de orçamento: ao alcançá-lo com progresso
  //    recente, o loop compacta o histórico (o mesmo apara do checkpoint) e
  //    renova a janela — exatamente o que o botão "Continuar" faria, só que
  //    sem parar nem depender do usuário. O freio de tarefa produtiva é falta
  //    de progresso (falhas seguidas, repetição, estagnação), nunca um
  //    contador de etapas; AGENT_MAX_AUTO_CONTINUES (padrão 6) é apenas o
  //    para-raios contra um loop "produtivo" infinito.
  const maxAutoContinues = Math.max(0, Number(process.env.AGENT_MAX_AUTO_CONTINUES ?? 6));
  let autoContinues = 0;
  let windowStart = 0; // etapa em que a janela de orçamento atual começou
  const executionRequired = forceExecution || modelPlan.requirements.required;
  const requiresOutput = modelPlan.requirements.expectsOutput;
  // No resume, tratamos os arquivos que JÁ existem (criados no run anterior)
  // como "entregáveis desta conclusão": assim eles reaparecem como download na
  // resposta final e não disparam o falso alarme de "arquivo não gerado" quando
  // a retomada só finaliza sem recriar o que já estava pronto.
  const outputsBefore = buildOutputBaseline(listOutputs(userId, conversationId), {
    acceptAll: Boolean(resume),
    continuationPaths: continuationOutputPaths
  });
  let finalText = '';
  const resetVisibleResponse = () => {
    if (!finalText) return;
    finalText = '';
    onEvent({ type: 'response_reset' });
  };
  let stopped = false;
  let completedNaturally = false;
  let consecutiveFailures = 0;
  let toolFallbackApplied = false;
  let executionRepairAttempted = false;
  let protocolRepairAttempted = false;
  // Em Pipeline com anexos, a primeira ação precisa ser uma ferramenta. Isso
  // impede modelos pequenos/gratuitos de responderem "não localizei o PDF"
  // sem sequer consultar o workspace que o backend acabou de confirmar.
  // EXCEÇÃO: com o conteúdo documental já injetado (Docling), forçar ferramenta
  // contradiz a instrução de "não reextrair" — o modelo já tem o material e
  // decide livremente se precisa de ferramentas (cálculos, geração de arquivo).
  const mustInspectUploads = Boolean(uploadNoteForRun && !docContext?.note && (forceExecution || modelPlan.requirements.reasons.includes('a leitura dos arquivos anexados')));
  let forceNativeToolCall = mustInspectUploads;
  let executedToolCalls = 0;
  let truncationContinuationAttempts = 0;
  let streamRecoveryAttempts = 0;
  let providerFailure = false;
  let incomplete = false;
  let failureMessage = '';
  const seenWebFetches = new Set();
  let unavailableWebSources = 0;
  let webFetchAttempts = 0;
  let webResearchStop = '';
  let webResearchConclusionAttempted = false;
  let awaitingUserReply = false;
  // Checkpoint: motivo da interrupção que JUSTIFICA salvar estado p/ retomar
  // (limite de ciclos, falha de provedor/stall exaurido, parada do usuário).
  // Falhas de QUALIDADE (degeneração, protocolo) NÃO viram checkpoint — ali o
  // certo é reenviar do zero, não continuar o mesmo array problemático.
  let checkpointReason = null;
  let reachedStep = 0;
  for (let step = 0; ; step++) {
    const windowStep = step - windowStart;
    // Passou do orçamento base? Só segue enquanto o trabalho ainda rende (uma
    // ferramenta executada com sucesso há poucas etapas). Se estagnou, encerra
    // como limite de etapas — as travas de falha (5 seguidas), repetição e
    // pesquisa web continuam valendo à parte.
    if (windowStep >= maxSteps && (step - lastProductiveStep) >= IDLE_STEP_GRACE) break;
    if (windowStep >= hardMaxSteps) {
      // Chegar aqui exige progresso recente (o teste acima já teria encerrado
      // uma tarefa estagnada) — então isto é trabalho legítimo que ficou
      // longo, não um loop. Renova a janela em vez de abortar no meio.
      if (autoContinues >= maxAutoContinues) break;
      autoContinues += 1;
      const objective = resume?.objective || userText;
      clearPromptCache(messages);
      const compacted = trimCheckpointMessages(messages, undefined, objective);
      messages.length = 0;
      for (const m of compacted) messages.push(m);
      // A nota de continuidade fica só uma vez, sempre no fim (fôlegos
      // repetidos não acumulam avisos).
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'system' && messages[i].content === AUTO_CONTINUE_NOTE) messages.splice(i, 1);
      }
      messages.push({ role: 'system', content: AUTO_CONTINUE_NOTE });
      resumePrefixEnd = leadingSystemCount(messages);
      applyPromptCache(messages, chosenModel, resumePrefixEnd, provider.baseURL);
      windowStart = step;
      onEvent({ type: 'status', content: `A tarefa está longa mas rendendo: compactei o histórico e continuei o trabalho (fôlego ${autoContinues} de ${maxAutoContinues}).` });
      emitExecutionState(onEvent, 'continuing', `Orçamento de etapas renovado (fôlego ${autoContinues})`, { runId, step });
    }
    reachedStep = step;
    if (await gate(control, onEvent)) { stopped = true; break; }
    onEvent({ type: 'status', content: step === 0 ? 'Pensando...' : 'Continuando...' });
    // Streaming: o texto é enviado token a token para a interface (tela viva)
    let content = '';
    let displayedContent = '';
    let degenerate = false;
    let lastDegenCheckLen = 0;
    const protocolGuard = createToolProtocolStreamGuard(tools.length > 0);
    const toolCalls = [];
    let finishReason = null;
    let stream;
    let activeRequest;
    try {
      activeRequest = beginProviderRequest(control);
      stream = await client.chat.completions.create(buildProviderRequest({
        model: rawModelId(chosenModel),
        messages,
        tools,
        forceNativeToolCall,
        reasoningEffort,
        reasoningParameter: modelRuntime.reasoningParameter,
        temperature,
        acceptsTemperature: modelRuntime.acceptsTemperature,
        baseURL: provider.baseURL
      }), { signal: activeRequest.signal, timeout: PROVIDER_CONNECT_TIMEOUT_MS });
    } catch (err) {
      // Marca de QUEM é a falha antes de qualquer coisa: o erro sobe por vários
      // caminhos (retomada, reserva, throw final) e a mensagem que chega ao
      // usuário precisa dizer qual chave foi recusada.
      tagProviderError(err, { providerName: provider.providerName, model: rawModelId(chosenModel) });
      const interrupted = controlInterruptReason(control, activeRequest);
      releaseProviderRequest(control, activeRequest);
      if (interrupted === 'stop') {
        stopped = true;
        break;
      }
      if (interrupted === 'pause') {
        onEvent({ type: 'status', content: 'Pausado' });
        step -= 1;
        continue;
      }
      // O modelo foi tratado como capaz de visão, mas recusou a imagem: corrige
      // o catálogo, remove as imagens e refaz a etapa (a leitura cai para OCR).
      if (isUnsupportedVisionError(err) && visionApplied) {
        markModelCapabilityUnsupported(chosenModel, 'vision');
        stripImagePartsFromMessages(messages);
        visionApplied = false;
        onEvent({ type: 'status', content: 'Este modelo não lê imagens diretamente; usando OCR no lugar.' });
        step -= 1;
        continue;
      }
      // tool_choice='required' × modo thinking: Qwen/GLM (e afins) respondem 400
      // quando a ferramenta é OBRIGATÓRIA com o raciocínio ligado. Refaz a mesma
      // etapa com tool_choice='auto' — as ferramentas continuam disponíveis; só
      // deixa de ser imposição (o modelo raciocinante decide chamá-las).
      if (isToolChoiceReasoningConflictError(err) && forceNativeToolCall) {
        forceNativeToolCall = false;
        onEvent({ type: 'status', content: 'Este modelo não aceita ferramenta obrigatória no modo de raciocínio; repetindo com chamada livre.' });
        step -= 1;
        continue;
      }
      if (!isUnsupportedToolError(err) || !tools.length || toolFallbackApplied) {
        if (isRetryableStreamError(err) && streamRecoveryAttempts < STREAM_RECOVERY_LIMIT) {
          streamRecoveryAttempts += 1;
          onEvent({ type: 'status', content: `O provedor demorou para responder. Tentando novamente (${streamRecoveryAttempts}/${STREAM_RECOVERY_LIMIT})...` });
          await retryDelay(streamRecoveryAttempts);
          step -= 1;
          continue;
        }
        if (isRetryableStreamError(err)) {
          const failedModel = chosenModel;
          const fb = activateNextFallback();
          if (fb) {
            onEvent({ type: 'status', content: `O provedor falhou com ${failedModel}. Tentando o modelo de reserva ${fb}...` });
            streamRecoveryAttempts = 0;
            step -= 1;
            continue;
          }
          providerFailure = true;
          checkpointReason = 'provider_failure';
          failureMessage = 'O provedor do modelo ficou indisponível antes de concluir a tarefa.';
          finalText += PROVIDER_TIMEOUT_NOTICE;
          onEvent({ type: 'delta', content: PROVIDER_TIMEOUT_NOTICE });
          completedNaturally = true;
          break;
        }
        // Modelo indisponível (404 / ID inexistente): antes o app encerrava a
        // tarefa de vez com "Modelo não encontrado". Agora, se houver modelo de
        // reserva, tenta o próximo em vez de dar erro fatal — só desiste quando
        // a cadeia de reserva se esgota (aí o erro real volta pelo throw).
        if (isModelUnavailableError(err)) {
          const failedModel = chosenModel;
          const fb = activateNextFallback();
          if (fb) {
            onEvent({ type: 'status', content: `O modelo ${failedModel} não está disponível no provedor. Tentando o modelo de reserva ${fb}...` });
            streamRecoveryAttempts = 0;
            step -= 1;
            continue;
          }
        }
        throw err;
      }
      const profile = markModelCapabilityUnsupported(chosenModel, 'tools') || modelPlan.profile;
      if (modelPlan.requirements.required) {
        const failedModel = chosenModel;
        const fb = activateNextFallback();
        if (fb) {
          onEvent({ type: 'status', content: `O modelo ${failedModel} não executa ferramentas. Continuando com o modelo de reserva ${fb}...` });
          streamRecoveryAttempts = 0;
          step -= 1;
          continue;
        }
        const unavailablePlan = { ...modelPlan, profile, capabilities: profile.capabilities, blocked: { capability: 'tools' } };
        finalText = modelCompatibilityMessage(unavailablePlan);
        onEvent({ type: 'status', content: 'Este modelo não executa ferramentas.' });
        onEvent({ type: 'delta', content: finalText });
        completedNaturally = true;
        break;
      }
      toolFallbackApplied = true;
      tools = [];
      messages[1] = { role: 'system', content: toolAvailabilityNote(tools, { sandboxNetworkEnabled }) };
      onEvent({ type: 'status', content: 'Este modelo não oferece ferramentas; respondendo em texto.' });
      step -= 1;
      continue;
    }
    let reasoningNotified = false;
    let pausedDuringStream = false;
    try {
    // Watchdog: se o provedor parar de mandar dados sem fechar a conexão,
    // aborta e cai na recuperação (retomar de onde parou / modelo de reserva)
    // em vez de deixar a resposta pendurada em "Raciocinando..." para sempre.
    for await (const chunk of guardStreamStall(stream, { onStall: () => activeRequest.abort('stall') })) {
      if (await gate(control, onEvent)) { stopped = true; break; }
      if (chunk.usage) addUsage(usage, chunk.usage);
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;
      // Modelos de raciocínio (R1, o1...) emitem "pensamento" invisível antes
      // do texto — avisa o usuário para a tela não parecer travada.
      if ((delta.reasoning || delta.reasoning_content) && !reasoningNotified) {
        reasoningNotified = true;
        onEvent({ type: 'status', content: 'Raciocinando... (este modelo pensa antes de responder e pode demorar)' });
      }
      if (delta.content) {
        const chunkText = String(delta.content);
        content += chunkText;
        const visible = protocolGuard.push(chunkText);
        if (visible) {
          displayedContent += visible;
          finalText += visible;
          onEvent({ type: 'delta', content: visible });
        }
        // Freio de repetição: se o modelo travar repetindo o mesmo trecho,
        // interrompe em vez de despejar um muro de texto repetido no chat.
        if (!degenerate && content.length - lastDegenCheckLen >= DEGEN_CHECK_STEP) {
          lastDegenCheckLen = content.length;
          if (looksDegenerate(content)) degenerate = true;
        }
        if (degenerate) break;
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] = toolCalls[i] || { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
      if (control.stopped) { stopped = true; break; }
    }
    } catch (err) {
      tagProviderError(err, { providerName: provider.providerName, model: rawModelId(chosenModel) });
      const interrupted = controlInterruptReason(control, activeRequest);
      if (interrupted === 'stop') {
        stopped = true;
      } else if (interrupted === 'pause') {
        pausedDuringStream = true;
      } else {
        if (!isRetryableStreamError(err)) throw err;
        if (streamRecoveryAttempts < STREAM_RECOVERY_LIMIT) {
          streamRecoveryAttempts += 1;
          if (content || toolCalls.filter(Boolean).length) {
            messages.push({ role: 'assistant', content: sanitizeToolProtocolText(content) });
            messages.push({ role: 'system', content: STREAM_RESUME_NOTE });
          }
          onEvent({ type: 'status', content: `A resposta do provedor foi interrompida. Retomando (${streamRecoveryAttempts}/${STREAM_RECOVERY_LIMIT})...` });
          await retryDelay(streamRecoveryAttempts);
          step -= 1;
          continue;
        }
        const failedModel = chosenModel;
        const fb = activateNextFallback();
        if (fb) {
          if (content || toolCalls.filter(Boolean).length) {
            messages.push({ role: 'assistant', content: sanitizeToolProtocolText(content) });
            messages.push({ role: 'system', content: STREAM_RESUME_NOTE });
          }
          onEvent({ type: 'status', content: `Falha no provedor com ${failedModel}. Continuando com o modelo de reserva ${fb}...` });
          streamRecoveryAttempts = 0;
          step -= 1;
          continue;
        }
        finalText += PROVIDER_TIMEOUT_NOTICE;
        providerFailure = true;
        checkpointReason = 'provider_failure';
        failureMessage = 'O provedor do modelo interrompeu a resposta antes de concluir a tarefa.';
        onEvent({ type: 'delta', content: PROVIDER_TIMEOUT_NOTICE });
        completedNaturally = true;
        break;
      }
    } finally {
      releaseProviderRequest(control, activeRequest);
    }
    const trailingVisible = protocolGuard.finish();
    if (trailingVisible) {
      displayedContent += trailingVisible;
      finalText += trailingVisible;
      onEvent({ type: 'delta', content: trailingVisible });
    }
    streamRecoveryAttempts = 0;
    if (stopped) break;
    if (degenerate) {
      const note = displayedContent.trim()
        ? '\n\n_A resposta foi interrompida: o modelo entrou em repetição (ficou repetindo o mesmo trecho). Use **Reenviar** ou escolha outro modelo._'
        : 'O modelo entrou em repetição e não produziu uma resposta útil. Use **Reenviar** ou escolha outro modelo.';
      finalText = sanitizeToolProtocolText(finalText) + note;
      onEvent({ type: 'delta', content: note });
      incomplete = true;
      failureMessage ||= 'O modelo entrou em repetição (saída degenerada).';
      completedNaturally = true;
      break;
    }
    if (pausedDuringStream) {
      if (content) {
        messages.push({ role: 'assistant', content: sanitizeToolProtocolText(content) });
        messages.push({ role: 'system', content: STREAM_PAUSE_RESUME_NOTE });
      }
      onEvent({ type: 'status', content: 'Pausado' });
      step -= 1;
      continue;
    }
    forceNativeToolCall = false;
    const nativeToolCalls = toolCalls.filter(Boolean);
    const textualProtocol = parseTextToolCalls(content, tools.map(tool => tool.function.name));
    let protocolMalformed = false;
    let candidateToolCalls = nativeToolCalls;
    if (textualProtocol.detected) {
      content = textualProtocol.visibleText || displayedContent;
      if (!nativeToolCalls.length && textualProtocol.malformed) {
        protocolMalformed = true;
        console.warn(`[agent] ${chosenModel} devolveu uma chamada textual de ferramenta malformada`);
      } else if (!nativeToolCalls.length && textualProtocol.calls.length) {
        candidateToolCalls = textualProtocol.calls.map((call, index) => ({
          id: `text_tool_${step}_${index}_${nanoid(8)}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments)
          }
        }));
        console.warn(`[agent] ${chosenModel} devolveu protocolo textual; convertido para chamada nativa: ${textualProtocol.calls.map(call => call.name).join(', ')}`);
        finishReason = 'tool_calls';
        onEvent({ type: 'status', content: 'Executando a ferramenta solicitada...' });
      }
    }

    const remainingWebFetches = Math.max(0, WEB_RESEARCH_FETCH_LIMIT - webFetchAttempts);
    const toolBatch = planToolCallBatch(candidateToolCalls, seenWebFetches, TOOL_CALLS_PER_STEP_LIMIT, remainingWebFetches);
    const stepToolCalls = toolBatch.calls;
    if (toolBatch.webStopReason && !webResearchStop) webResearchStop = toolBatch.webStopReason;
    // Reenvia só o que a API espera (evita campos extras como reasoning_content)
    messages.push({ role: 'assistant', content: content ?? '', ...(stepToolCalls.length ? { tool_calls: stepToolCalls } : {}) });
    if (protocolMalformed) {
      if (!protocolRepairAttempted && tools.length) {
        protocolRepairAttempted = true;
        forceNativeToolCall = true;
        resetVisibleResponse();
        messages.push({ role: 'system', content: TOOL_PROTOCOL_REPAIR_NOTE });
        onEvent({ type: 'status', content: 'Corrigindo uma chamada de ferramenta inválida...' });
        continue;
      }
      incomplete = true;
      failureMessage = 'O modelo devolveu a chamada de ferramenta em um formato inválido.';
      finalText += TOOL_PROTOCOL_FAILURE_NOTICE;
      onEvent({ type: 'delta', content: TOOL_PROTOCOL_FAILURE_NOTICE });
      completedNaturally = true;
      break;
    }
    if (!stepToolCalls.length) {
      if (webResearchStop && !webResearchConclusionAttempted) {
        webResearchConclusionAttempted = true;
        tools = tools.filter(tool => !WEB_TOOL_NAMES.has(tool.function.name));
        messages[1] = { role: 'system', content: toolAvailabilityNote(tools, { sandboxNetworkEnabled }) };
        messages.push({ role: 'system', content: webResearchFinalizationNote(webResearchStop) });
        onEvent({ type: 'status', content: 'Reunindo o que encontrei e cruzando as fontes...' });
        step -= 1;
        continue;
      }
      const outputsSoFar = listOutputs(userId, conversationId);
      if (shouldContinueAfterTruncation(finishReason, truncationContinuationAttempts)) {
        truncationContinuationAttempts += 1;
        messages.push({ role: 'system', content: RESPONSE_TRUNCATED_REPAIR_NOTE });
        onEvent({ type: 'status', content: 'Continuando uma resposta que foi cortada...' });
        continue;
      }
      const missingClaimedOutput = shouldRepairOutputDelivery(content, outputsBefore, outputsSoFar);
      // O modelo terminou PERGUNTANDO algo ao usuário (escopo, opção, permissão):
      // o turno acabou — entregar a pergunta e aguardar a resposta. Forçar a
      // execução aqui (reparo com tool_choice='required') fazia o modelo
      // "responder a própria pergunta" e decidir sozinho, sem o usuário conseguir
      // intervir. Em tarefas de segundo plano (forceExecution) não há usuário
      // presente para responder — lá o comportamento antigo continua valendo.
      awaitingUserReply = !forceExecution && !missingClaimedOutput && endsAwaitingUserReply(content);
      const incompleteExecution = !awaitingUserReply && shouldRepairExecution({
        requiresExecution: executionRequired,
        requiresOutput,
        toolsAvailable: tools.length > 0,
        executedToolCalls,
        outputsBefore,
        outputsAfter: outputsSoFar,
        responseText: content
      });
      if (!executionRepairAttempted && tools.length && (missingClaimedOutput || incompleteExecution)) {
        executionRepairAttempted = true;
        forceNativeToolCall = true;
        resetVisibleResponse();
        messages.push({ role: 'system', content: missingClaimedOutput ? OUTPUT_DELIVERY_REPAIR_NOTE : EXECUTION_COMPLETION_REPAIR_NOTE });
        onEvent({ type: 'status', content: missingClaimedOutput ? 'Conferindo o arquivo prometido...' : 'Executando o trabalho solicitado...' });
        continue;
      }
      if (executionRepairAttempted && (missingClaimedOutput || incompleteExecution)) {
        incomplete = true;
        failureMessage = 'A execução solicitada não produziu um resultado verificável.';
        finalText += EXECUTION_INCOMPLETE_NOTICE;
        onEvent({ type: 'delta', content: EXECUTION_INCOMPLETE_NOTICE });
      }
      if (String(finishReason || '').toLowerCase() === 'length') {
        finalText += RESPONSE_TRUNCATED_NOTICE;
        onEvent({ type: 'delta', content: RESPONSE_TRUNCATED_NOTICE });
      }
      completedNaturally = true;
      break;
    }
    // DELEGAÇÕES EM PARALELO: as chamadas de sub-agente deste lote são lançadas
    // ANTES do laço, todas de uma vez (respeitando o teto de simultâneas). As
    // demais ferramentas continuam em série, e o laço abaixo apenas AGUARDA a
    // delegação quando chega a vez dela — assim os resultados entram na ordem
    // das tool_calls (o array de mensagens exige esse pareamento), mas o tempo
    // de parede é o da delegação mais lenta, não a soma de todas.
    const delegations = new Map();
    for (const call of stepToolCalls) {
      if (call.function.name !== SUBAGENT_TOOL_NAME) continue;
      if (!isToolCallAllowed(SUBAGENT_TOOL_NAME, tools) || subagentRuns >= subagentBudget) break;
      subagentRuns += 1;
      let delegationArgs = {};
      try { delegationArgs = JSON.parse(call.function.arguments || '{}'); } catch {}
      onEvent({ type: 'tool_start', id: call.id, name: SUBAGENT_TOOL_NAME, preview: String(delegationArgs.tarefa || '').slice(0, 400) });
      emitExecutionState(onEvent, 'tool_running', SUBAGENT_TOOL_NAME, { runId, step, tool: SUBAGENT_TOOL_NAME });
      delegations.set(call.id, delegationSlot(() => runSubagent({
        userId,
        conversationId,
        args: delegationArgs,
        model: chosenModel,
        effort,
        control,
        onEvent,
        depth: subagentDepth,
        webSearch: webSearchActive,
        delegationId: call.id
      })));
    }
    for (let callIdx = 0; callIdx < stepToolCalls.length; callIdx++) {
      const call = stepToolCalls[callIdx];
      const pendingDelegation = delegations.get(call.id) || null;
      if (await gate(control, onEvent)) {
        stopped = true;
        // Parada ENTRE chamadas do mesmo lote: o assistant já foi empilhado com
        // TODAS as tool_calls (acima), mas as ainda NÃO executadas ficariam sem
        // o `tool` result correspondente. Um array assim é inválido para a API
        // (a retomada do checkpoint falharia com 400 — "an assistant message
        // with tool_calls must be followed by tool messages"). Registramos um
        // resultado "cancelado" para cada chamada restante, mantendo o par
        // tool_call/tool_result íntegro e o checkpoint retomável.
        for (let k = callIdx; k < stepToolCalls.length; k++) {
          // Delegação já lançada e ainda em voo: o filho enxerga o mesmo
          // controle e encerra sozinho — esperamos por ele só para somar a
          // usage do trabalho que chegou a acontecer antes da parada.
          const inFlight = delegations.get(stepToolCalls[k].id);
          if (inFlight) {
            const partial = await inFlight;
            if (partial?.usage) addUsage(usage, partial.usage);
            onEvent({ type: 'tool_result', id: stepToolCalls[k].id, name: SUBAGENT_TOOL_NAME, content: partial?.result?.slice(0, 2000) || '' });
          }
          messages.push({ role: 'tool', tool_call_id: stepToolCalls[k].id, content: JSON.stringify({ error: 'Execução interrompida pelo usuário antes desta ferramenta.', code: 'CANCELED' }) });
        }
        break;
      }
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); }
      catch (err) { console.warn(`[agent] argumentos malformados da ferramenta "${name}" (seguindo com {}):`, err.message); }
      // Prévia do que a ferramenta vai executar (exibida na interface)
      const preview = String(args.code || args.command || args.prompt || args.path || args.query || args.url || '').slice(0, 400);
      // Prévia rica p/ o Ambiente de Trabalho: ao gravar arquivo, manda também o
      // conteúdo escrito (o resultado só traz o caminho) para o painel de detalhe
      // mostrar o que a IA de fato salvou. Limitado para não pesar no stream.
      const detail = name === 'write_file' ? String(args.content || '').slice(0, 4000) : '';
      // As delegações já anunciaram o início ao serem lançadas (acima).
      if (!pendingDelegation) {
        onEvent({ type: 'tool_start', id: call.id, name, preview, ...(detail ? { detail } : {}) });
        emitExecutionState(onEvent, 'tool_running', name, { runId, step, tool: name });
      }
      let result;
      const allowedToolCall = isToolCallAllowed(name, tools);
      const isWebTool = name === 'web_search' || name === 'web_fetch';
      const fetchUrl = name === 'web_fetch' ? normalizeWebFetchUrl(args.url) : '';
      const repeatedFetch = Boolean(fetchUrl && seenWebFetches.has(fetchUrl));
      if (name === 'web_fetch' && !repeatedFetch) {
        if (fetchUrl) seenWebFetches.add(fetchUrl);
        webFetchAttempts += 1;
      }
      if (!allowedToolCall) {
        result = JSON.stringify({ error: 'Ferramenta não autorizada para esta chamada.', code: 'TOOL_NOT_ALLOWED', tool: name });
      } else if (isWebTool && webResearchStop) {
        result = JSON.stringify({ error: 'A pesquisa web já atingiu o limite desta tarefa. Conclua com as evidências obtidas.', code: 'WEB_RESEARCH_STOPPED' });
      } else if (repeatedFetch) {
        result = JSON.stringify({ error: 'Esta URL já foi consultada nesta tarefa. Use uma fonte nova ou conclua com as evidências obtidas.', code: 'DUPLICATE_WEB_FETCH', url: args.url });
      } else if (name === SUBAGENT_TOOL_NAME) {
        // Delegação: NÃO passa pelo runTool (o sub-agente não roda no sandbox —
        // ele é outro runAgent). Sem promessa lançada, a chamada ficou fora do
        // teto desta execução: devolve erro e o modelo segue sem delegar, no
        // estilo dos demais freios do loop.
        if (!pendingDelegation) {
          result = JSON.stringify({ error: `O limite de ${subagentBudget} delegações desta tarefa foi alcançado. Conclua a subtarefa você mesmo.`, code: 'SUBAGENT_LIMIT' });
        } else {
          const delegation = await pendingDelegation;
          // A usage do filho entra na do pai — o custo real nunca some do painel.
          if (delegation.usage) addUsage(usage, delegation.usage);
          if (delegation.stopped) stopped = true;
          result = delegation.result;
        }
      } else {
        const activeTool = beginToolRequest(control);
        try {
          result = await runTool(conversationId, name, args, sandboxOptions, { signal: activeTool.signal });
        } catch (err) {
          if (controlInterruptReason(control, activeTool) === 'stop') {
            stopped = true;
            result = JSON.stringify({ error: 'Execucao interrompida pelo usuario.', code: 'CANCELED' });
          } else {
            result = JSON.stringify({ error: err.message });
          }
        } finally {
          releaseToolRequest(control, activeTool);
        }
      }
      executedToolCalls += 1;
      // A miniatura da página (web_fetch) vai num campo SEPARADO do stream: o
      // `content` é cortado em 2000 chars e o caminho poderia ficar de fora.
      let thumb = '';
      if (name === 'web_fetch') { try { thumb = JSON.parse(result).thumb || ''; } catch {} }
      onEvent({ type: 'tool_result', id: call.id, name, content: result.slice(0, 2000), ...(thumb ? { thumb } : {}) });
      emitExecutionState(onEvent, 'processing_result', name, { runId, step, tool: name });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      // Freio de loop: conta falhas consecutivas das ferramentas
      const outcome = classifyToolOutcome(name, result);
      consecutiveFailures = outcome.failed && !outcome.recoverable ? consecutiveFailures + 1 : 0;
      if (outcome.webUnavailable) unavailableWebSources += 1;
      const researchReason = webResearchStopReason({
        repeatedFetch,
        unavailableSources: unavailableWebSources,
        fetchAttempts: webFetchAttempts
      });
      if (researchReason && !webResearchStop) webResearchStop = researchReason;
    }
    if (stopped) break;
    emitExecutionState(onEvent, 'continuing', 'Resultado processado; escolhendo a próxima etapa', { runId, step });
    // Checkpoint seguro entre lotes: nunca é gravado no meio de uma ferramenta.
    // Se o backend cair no próximo stream, a retomada parte daqui sem repetir
    // as chamadas que já terminaram. Uma conclusão limpa apaga este registro.
    // O sub-agente NÃO grava: o checkpoint tem uma linha por CONVERSA, então o
    // filho sobrescreveria (e, ao terminar, apagaria) o checkpoint do pai — que
    // é o run de verdade, o único retomável pelo botão "Continuar".
    if (!isSubagent) {
      await saveCheckpoint({
        userId, conversationId, runId,
        objective: resume?.objective || userText,
        reason: 'progress',
        model: chosenModel,
        triedModels: [...triedModels],
        step: (resume?.step || 0) + step,
        messages,
        usage,
        meta: { safePoint: 'after_tool_batch', webSearch: Boolean(webSearch), effort: effort || null, developer: developer || null, assistantId: assistant?.id || null }
      });
    }
    // Etapa produtiva: executou ferramenta(s) e a última não falhou em cadeia.
    // Serve de sinal para permitir passar do orçamento base (ver topo do loop).
    if (consecutiveFailures === 0) lastProductiveStep = step;
    if (webResearchStop && !webResearchConclusionAttempted) {
      webResearchConclusionAttempted = true;
      tools = tools.filter(tool => !WEB_TOOL_NAMES.has(tool.function.name));
      messages[1] = { role: 'system', content: toolAvailabilityNote(tools, { sandboxNetworkEnabled }) };
      messages.push({ role: 'system', content: webResearchFinalizationNote(webResearchStop) });
      onEvent({ type: 'status', content: 'Concluindo a pesquisa com as fontes já verificadas...' });
      step -= 1;
      continue;
    }
    if (consecutiveFailures >= 5) {
      incomplete = true;
      failureMessage = 'As ferramentas falharam repetidamente durante a execução da tarefa.';
      const note = `\n\n**Não consegui concluir esta execução.** Interrompi após ${consecutiveFailures} falhas seguidas para evitar um loop. Use **Reenviar** para tentar novamente; o detalhe técnico continua disponível nas etapas de ferramenta acima.`;
      finalText += note;
      onEvent({ type: 'delta', content: note });
      completedNaturally = true; // evita acumular também o aviso de limite de etapas
      break;
    }
  }

  if (stopped) {
    onEvent({ type: 'status', content: 'Interrompido pelo usuário' });
    if (!finalText.trim()) { finalText = '_Processamento interrompido pelo usuário._'; onEvent({ type: 'delta', content: finalText }); }
    // Só oferece retomada se houve progresso real (ferramenta executada) — assim
    // o usuário pode continuar uma tarefa que ele mesmo pausou.
    if (executedToolCalls > 0) checkpointReason = 'stopped';
  }
  else if (!completedNaturally) {
    incomplete = true;
    checkpointReason = 'step_limit';
    failureMessage = `A tarefa atingiu o limite de ${reachedStep + 1} etapas antes da conclusão.`;
    // Atingiu o limite de etapas ainda usando ferramentas: avisa de forma honesta
    // e diz como retomar. O progresso é salvo num checkpoint (backend), então a
    // retomada CONTINUA de onde parou — não recomeça.
    const note = `\n\n_⚠️ Esta tarefa ficou longa e precisei pausá-la para não rodar sem fim. **O progresso foi salvo.** Toque em **Continuar** para eu retomar exatamente de onde parei (sem refazer o que já fiz); se for algo grande, ajuda dividir em etapas menores._`;
    finalText += note;
    onEvent({ type: 'delta', content: note });
  }
  // Detecta os arquivos gerados NESTA resposta e os anexa à mensagem
  let outputsAfter = listOutputs(userId, conversationId);
  let newFiles = outputsAfter.filter(f => outputsBefore.get(f.path) !== fileSignature(f));
  if (!newFiles.length && mentionsOutputPath(finalText)) {
    await recoverAlternateOutputs(conversationId, sandboxOptions);
    outputsAfter = listOutputs(userId, conversationId);
    newFiles = outputsAfter.filter(f => outputsBefore.get(f.path) !== fileSignature(f));
  }
  if (!newFiles.length && mentionsOutputPath(finalText)) newFiles = referencedOutputFiles(finalText, outputsAfter);
  if (!newFiles.length && mentionsOutputPath(finalText) && materializeTextOutput(userId, conversationId, finalText)) {
    outputsAfter = listOutputs(userId, conversationId);
    newFiles = outputsAfter.filter(f => outputsBefore.get(f.path) !== fileSignature(f));
  }
  // Turno encerrado numa pergunta ao usuário: não é execução incompleta — o
  // arquivo/trabalho virá depois que ele responder.
  if (!newFiles.length && !awaitingUserReply && (requiresOutput || mentionsOutputPath(finalText))) {
    incomplete = true;
    failureMessage ||= 'A tarefa solicitou um arquivo, mas nenhum arquivo foi criado.';
    const alreadyExplained = /\*\*(?:Não consegui|O arquivo não foi gerado)/i.test(finalText);
    if (!alreadyExplained) {
      finalText += MISSING_OUTPUT_NOTICE;
      onEvent({ type: 'delta', content: MISSING_OUTPUT_NOTICE });
    }
  }
  finalText = sanitizeToolProtocolText(finalText);
  if (!finalText.trim() && newFiles.length) {
    finalText = `Concluído. ${newFiles.length === 1 ? `O arquivo **${newFiles[0].name}** está disponível para download abaixo.` : `Os ${newFiles.length} arquivos gerados estão disponíveis para download abaixo.`}`;
    onEvent({ type: 'delta', content: finalText });
  } else if (!finalText.trim()) {
    incomplete = executionRequired || incomplete;
    failureMessage ||= executionRequired
      ? 'A execução terminou sem produzir um resultado verificável.'
      : 'O modelo terminou sem produzir uma resposta.';
    finalText = executionRequired
      ? (requiresOutput ? MISSING_OUTPUT_NOTICE.trim() : EXECUTION_INCOMPLETE_NOTICE.trim())
      : 'O modelo terminou sem gerar uma resposta. Use **Reenviar** ou escolha outro modelo.';
    onEvent({ type: 'delta', content: finalText });
  }
  // TRANSPARÊNCIA DE MODELO: se um failover trocou o modelo no meio da execução,
  // registra isso na própria resposta (não só num status efêmero que some). O
  // estado/badge já reporta o modelo final, mas a nota garante que o usuário
  // SEMPRE saiba, no texto salvo, que a tarefa terminou num modelo diferente do
  // escolhido — sem substituição silenciosa.
  if (rawModelId(chosenModel) !== rawModelId(startedModel)) {
    const modelSwitchNote = `\n\n_ℹ️ O modelo escolhido (**${rawModelId(startedModel)}**) ficou indisponível durante a execução; a tarefa foi concluída com o modelo de reserva **${rawModelId(chosenModel)}**. Para uma indisponibilidade retornar erro em vez de trocar de modelo, não configure modelos de reserva (variável MODEL_FALLBACKS)._`;
    finalText += modelSwitchNote;
    onEvent({ type: 'delta', content: modelSwitchNote });
  }
  // Validação dos artefatos: pulada no sub-agente. Os arquivos que ele gerou
  // estão no MESMO workspace e entram no `newFiles` do pai, que os valida uma
  // vez só — validar duas vezes seria custo de sandbox repetido.
  let checks = {};
  if (newFiles.length && !stopped && !isSubagent) {
    emitExecutionState(onEvent, 'validating', 'Validando os artefatos antes da entrega', { runId });
    checks = await validateOutputs(conversationId, newFiles, onEvent, sandboxOptions);
    if (Object.values(checks).some(check => check?.ok === false)) {
      incomplete = true;
      failureMessage ||= 'Um ou mais arquivos gerados falharam na validação automática.';
      const validationNotice = '\n\n_⚠️ O arquivo foi gerado, mas não passou em toda a validação automática. Confira os detalhes no cartão antes de usá-lo._';
      finalText += validationNotice;
      onEvent({ type: 'delta', content: validationNotice });
    }
  }
  // CHECKPOINT: interrompida por limite/infra/parada com progresso real → salva
  // o estado (mesmo mecanismo p/ limite de ciclos E watchdog/provedor). Caso
  // contrário (conclusão limpa, ou falha de qualidade), limpa qualquer
  // checkpoint antigo — não há o que retomar. `messages.length > 3` evita salvar
  // um checkpoint que seja só o preâmbulo, sem trabalho de verdade.
  // O checkpoint da conversa pertence ao PAI: o sub-agente não grava nem limpa.
  // Se a subtarefa foi interrompida, o pai recebe isso no resultado da
  // ferramenta e decide (refazer, seguir sem ela ou parar) — e é o run dele que
  // fica retomável pelo botão "Continuar".
  const ownsCheckpoint = !isSubagent;
  let resumable = false;
  if (ownsCheckpoint && isResumableReason(checkpointReason) && messages.length > 3) {
    resumable = await saveCheckpoint({
      userId, conversationId, runId,
      objective: resume?.objective || userText,
      reason: checkpointReason,
      model: chosenModel,
      triedModels: [...triedModels],
      step: (resume?.step || 0) + reachedStep,
      messages,
      usage,
      meta: { webSearch: Boolean(webSearch), effort: effort || null, developer: developer || null, assistantId: assistant?.id || null, sandboxNetworkEnabled, prompt: promptManifest }
    });
    // Avisa a interface AO VIVO que dá para retomar (sem esperar um reload):
    // o botão "Continuar" aparece na mensagem interrompida.
    if (resumable) onEvent({ type: 'resumable', value: true });
  } else if (ownsCheckpoint) {
    await clearCheckpoint(conversationId);
  }
  const finalState = finalExecutionState({ stopped, awaitingUserReply, resumable, providerFailure, incomplete });
  const execution = emitExecutionState(onEvent, finalState, failureMessage || null, {
    runId,
    model: chosenModel,
    toolsExecuted: executedToolCalls,
    toolsAvailable: tools.map(tool => tool.function.name),
    sandboxNetworkEnabled,
    prompt: promptManifest,
    resumable,
    validation: checks
  });
  // Persistência e cartões só acontecem depois da validação. O estado gravado
  // é a fonte de verdade quando a conversa for reaberta.
  // O sub-agente NUNCA persiste: mesmo interrompido ou incompleto, o texto dele
  // é resultado de ferramenta do pai, não uma resposta na conversa. (Sem este
  // `!isSubagent`, o `persistReply: false` seria ignorado justamente nos casos
  // de falha — que são os mais comuns numa subtarefa que dá errado.)
  const shouldPersistReply = !isSubagent && (persistReply || stopped || resumable || providerFailure || incomplete || awaitingUserReply);
  let msgId = null;
  if (shouldPersistReply) {
    const persisted = await persistAssistantReply(userId, conversationId, finalText, memoryMeta, newFiles, { executionMeta: execution });
    msgId = persisted.msgId;
    if (persisted.cards.length) onEvent({ type: 'files', files: persisted.cards });
    if (Object.keys(checks).length) onEvent({ type: 'file_checks', checks });
    onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: msgId });
  }
  // Memória: indexa a troca e extrai fatos em segundo plano (não bloqueia)
  if (!stopped && shouldPersistReply) indexAfterReply(userId, conversationId).catch(() => {});
  return { text: finalText, usage, model: chosenModel, stopped, providerFailure, incomplete, failureMessage, resumable, execution, files: newFiles, checks, messageId: msgId };
  } finally {
    // Mantém a conversa marcada como ativa até o card de download ter sido
    // persistido e emitido. Isso impede uma exclusão concorrente de apagar o
    // pai da mensagem e quebrar a chave estrangeira no final da resposta.
    if (ownsControl) releaseConversationControl(conversationId, control);
  }
}
