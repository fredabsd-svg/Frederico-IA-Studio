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
import { hasGithubConnection } from '../connectors/github.js';
import { githubPreflight, githubPreflightNote, githubToolsForContext, normalizeGithubWriteAuthorization } from './githubAccess.js';
import { ASK_USER_TOOL_NAME, askUserToolDefinition, normalizeInputRequest, shouldOfferAskUser, textInputRequest } from './userInputRequest.js';
import { UPDATE_PLAN_TOOL_NAME, updatePlanToolDefinition, normalizePlanUpdate, shouldOfferUpdatePlan, PLAN_TOOL_NOTE } from './planTool.js';
import { effortCfg, promptFor, promptManifestFor, toolsFor, temperatureFor, developerContextFor, toolAvailabilityNote, ENVIRONMENT_QUERY_RE, verifiedEnvironmentNote, pcFoldersNote, uploadsNote, clipForBriefing, BRIEFING_CHAR_LIMIT, QUALITY_BAR, PLAN_DELEGATION_TOPIC } from './prompts.js';
import { listOutputs, mentionsOutputPath, recoverAlternateOutputs, referencedOutputFiles, fileSignature, validateOutputs } from './outputs.js';
import { OUTPUT_DELIVERY_REPAIR_NOTE, MISSING_OUTPUT_NOTICE, EXECUTION_COMPLETION_REPAIR_NOTE, EXECUTION_INCOMPLETE_NOTICE, TOOL_PROTOCOL_REPAIR_NOTE, TOOL_PROTOCOL_FAILURE_NOTICE, RESPONSE_TRUNCATED_REPAIR_NOTE, RESPONSE_TRUNCATED_NOTICE, EXECUTION_CONTRACT_NOTE, MACRO_REQUEST_RE, MACRO_LIMITATION_NOTE, DEGEN_CHECK_STEP, looksDegenerate, shouldRepairOutputDelivery, shouldRepairExecution, shouldContinueAfterTruncation, materializeTextOutput, endsAwaitingUserReply } from './repair.js';
import { normalizeWebFetchUrl, classifyToolOutcome, webResearchStopReason, planToolCallBatch, WEB_TOOL_NAMES, webResearchFinalizationNote, WEB_RESEARCH_FETCH_LIMIT, TOOL_CALLS_PER_STEP_LIMIT } from './webResearch.js';
import { imageUploadParts, attachImagesToLastUserMessage, stripImagePartsFromMessages } from './vision.js';
import { STREAM_RECOVERY_LIMIT, STREAM_RESUME_NOTE, STREAM_PAUSE_RESUME_NOTE, PROVIDER_TIMEOUT_NOTICE, isRetryableStreamError, openRouterRouting, retryDelay, addUsage, applyPromptCache, clearPromptCache, tagProviderError } from './provider.js';
import { guardStreamStall, PROVIDER_CONNECT_TIMEOUT_MS } from './streamGuard.js';
import { acquireConversationControl, releaseConversationControl, beginProviderRequest, releaseProviderRequest, beginToolRequest, releaseToolRequest, controlInterruptReason, gate } from './control.js';
import { clientScopeFor, memoryNote, saveMessage, persistAssistantReply } from './persistence.js';
import { saveCheckpoint, clearCheckpoint, isResumableReason, buildResumeMessages, leadingSystemCount, trimCheckpointMessages, AUTO_CONTINUE_NOTE } from './checkpoint.js';
import { untrustedContext, untrustedToolResult } from './promptRegistry.js';
import { finalExecutionState } from './executionState.js';
import { createRunStateTracker } from './runStateMachine.js';
import { resolveSandboxNetwork, isToolCallAllowed } from './assistantPolicy.js';
import { evaluateShellCommand, normalizeCommandGrants } from './permissionPolicy.js';
import { createDoomLoopDetector, doomLoopResult } from './doomLoop.js';
import { explicitlyAuthorizesPcWrite } from '../execGuard.js';
import { takeSandboxRestartNotice, sandboxOpenTransaction } from '../sandbox.js';
import { formatRestartNotice, formatOpenTransactionNotice } from '../agentEnv.js';
import { SUBAGENT_TOOL_NAME, subagentToolDefinitionFor, listSubagentSpecialists, buildDelegationContext, intersectToolDefinitions, canLaunchDelegationsInParallel, shouldOfferSubagentTool, maxSubagentsPerRun, createSubagentLimiter, runSubagent, buildSubagentBudget, shouldNudgeSubagent, SUBAGENT_NUDGE_NOTE } from './subagents.js';
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
export async function runAgent({ userId, conversationId, userText, model, assistant, webSearch, effort, developer, onEvent, saveUserMessage = true, existingUserMessageId = null, executionBriefing = null, forceExecution = false, interactive = true, control: inheritedControl = null, resume = null, gitWriteAuthorization = null, persistReply = true, continuationOutputPaths = [], subagentDepth = 0, delegation = null, runIdOverride = null, outputsSubdir = null, subagentRunBudget = null }) {
  // Execução DELEGADA (sub-agente): compartilha a conversa e o workspace com o
  // pai, mas não é dona da conversa — não grava mensagem, não grava checkpoint
  // e não delega de novo. Quem responde ao usuário e é retomável é o pai.
  const isSubagent = subagentDepth > 0;
  // Contexto de delegação: presente SÓ no filho. Enquanto ele existe, nada de
  // permissão é derivado do `userText` — que, aqui, é texto escrito pelo modelo
  // principal, não pelo usuário.
  const inherited = isSubagent && delegation ? delegation : null;
  // `assistant.model_ref` (forma completa `<provedor>::<modelo>`) tem prioridade
  // sobre `assistant.model` (id cru, legado): resolve sem ambiguidade e impede
  // o `getUserProvider` de cair no `rows[0]` quando o modelo não bate com
  // catálogo nenhum. Quando só o id cru existe (linhas anteriores à migration
  // 028), o resolver tenta casar com o catálogo dos provedores cadastrados.
  const requestedModel = resume?.model
    || model
    || assistant?.model_ref
    || assistant?.model
    || '';
  const provider = await getUserProvider(userId, requestedModel); // chave dona do modelo
  const client = provider.client;                          // sombreia o cliente global
  // runIdOverride: a rota pode impor um id (compartilhado com o live stream) para
  // que todos os eventos do run saiam com o MESMO carimbo. Sem isto, a
  // reconexão por SSE não consegue dizer "ainda é o mesmo run" e o fromSeq
  // antigo pularia eventos do run novo.
  const runId = runIdOverride || resume?.runId || nanoid();
  // MÁQUINA DE ESTADOS EXPLÍCITA (Developer Workspace 3.0): todo `run_state`
  // deste run sai por este rastreador, que valida a transição contra a tabela
  // de runStateMachine.js. O backend é a fonte de verdade do estado; a UI
  // nunca deduz "concluído" do fim do stream.
  const runState = createRunStateTracker({ runId, onEvent });
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
  // AUTORIZAÇÃO DE PUBLICAÇÃO — duas fontes, nesta ordem:
  //   1. estruturada, registrada por ação explícita do usuário e escopada a
  //      repositório/branch/base/ações (`developer.permissions`). Sobrevive a
  //      turnos seguintes e à retomada, porque viaja no checkpoint junto com
  //      `developer`;
  //   2. o texto DESTE turno ("faça o commit e abra o PR"), mantido por
  //      compatibilidade — mas escopado ao vínculo, nunca global.
  // O parâmetro `gitWriteAuthorization` continua aceito (chamadores internos e
  // testes) e, quando vem `false`, VETA as duas fontes.
  const structuredGithubAuthorization = normalizeGithubWriteAuthorization(developer?.permissions);
  // AUTORIZAÇÕES DE COMANDO (permissionPolicy, allow/ask/deny): concedidas pelo
  // usuário ao confirmar um ask_user de permissão; re-validadas aqui (falha
  // fechada — só padrões `ask` da política sobrevivem). No filho, herdadas do
  // pai — nunca derivadas do texto da subtarefa, que é escrito pelo modelo.
  const commandGrants = inherited
    ? (inherited.commandGrants || [])
    : normalizeCommandGrants(developer?.permissions);
  const turnAuthorizesGitWrite = gitWriteAuthorization == null
    ? explicitlyAuthorizesGitWrite(userText)
    : Boolean(gitWriteAuthorization);
  const lowSignalTurn = isLowSignalTurn(userText);
  // O filho herda o contexto do Modo Desenvolvedor do pai INTEIRO (modo,
  // projeto, repositório, escopo de escrita). Sem isso, o pai rodava com
  // política `write:<projeto>` e o filho com `read-only`/`default`: na primeira
  // ferramenta o filho derrubava o container do pai e criava outro, o pai
  // devolvia o favor na ferramenta seguinte, e o resultado era comando morto no
  // meio, arquivo pela metade e falha impossível de reproduzir.
  //
  // A montagem é em DUAS passadas de propósito: o pré-voo do GitHub precisa
  // conhecer o VÍNCULO (repositório/branch/modo) para decidir a publicação, e a
  // nota do Modo Desenvolvedor precisa da DECISÃO do pré-voo para não anunciar
  // "publicação autorizada" quando o executor não recebeu github_push. Antes, as
  // duas coisas eram calculadas de fontes diferentes — e divergiam.
  // `developerContextFor` é pura e barata (só lê os mounts do usuário).
  const bindingContext = inherited
    ? inherited.developerContext
    : developerContextFor(developer, userId, { githubConnected, gitWriteAuthorized: false });
  const githubState = githubPreflight({
    githubConnected,
    developerContext: bindingContext,
    authorization: structuredGithubAuthorization,
    turnAuthorizesWrite: turnAuthorizesGitWrite && gitWriteAuthorization !== false,
    base: structuredGithubAuthorization?.base || null,
    lowSignalTurn,
    isSubagent
  });
  const gitWriteAuthorized = githubState.writeAuthorized;
  const developerContext = inherited
    ? inherited.developerContext
    : developerContextFor(developer, userId, { githubConnected, gitWriteAuthorized });
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
  // A política persistente (Configurações → Sandbox e rede) decide o padrão:
  // automático (só quando o pedido pede), sempre ligada ou sempre desligada.
  // Não toca nas chamadas dos modelos — essas saem do backend.
  // No filho a rede vem do pai, nunca do texto da subtarefa: um "acesse a API"
  // que o próprio modelo escreveu não pode abrir a rede do container.
  const sandboxNetworkEnabled = inherited
    ? inherited.networkEnabled
    : (!lowSignalTurn && (resume
      ? Boolean(resume?.meta?.sandboxNetworkEnabled)
      : resolveSandboxNetwork(getSettings().sandbox_network_policy, userText)));
  const promptManifest = promptManifestFor(assistant, developerContext ? ['developer'] : []);
  // ESCRITA nas Pastas do PC (arquivos REAIS e insubstituíveis do usuário).
  // No Modo Desenvolvedor, escolher um projeto gravável + um modo de escrita JÁ
  // é a autorização, e ela é escopada àquela pasta. No chat comum, a decisão é
  // do backend a partir do pedido DESTE turno — igual à rede do sandbox. Sem
  // pedido explícito, as pastas são montadas somente-leitura (garantia do
  // Docker, não só do prompt).
  // Mesma regra da rede: no filho, a escrita em arquivos REAIS do usuário é a
  // que o pai já tinha. `explicitlyAuthorizesPcWrite` lê o pedido do turno — e
  // o "pedido" do filho é texto de IA.
  const pcWriteAuthorized = inherited
    ? inherited.pcWriteAuthorized
    : (!lowSignalTurn && (developerContext
      ? !developerContext.readOnlyProject
      : explicitlyAuthorizesPcWrite(userText)));
  // userId viaja junto: o sandbox monta só as pastas do PC DESTE usuário
  // (isolamento multi-tenant) e aplica o limite de sandboxes por usuário.
  // No filho, as opções são as MESMAS do pai (só o modelo muda, e ele não entra
  // na chave da política) — assim os dois caem no mesmo container, sem a troca
  // de política que reciclava o sandbox no meio da execução.
  // `outputsSubdir` é o F-25: cada sub-agente roda numa subpasta de outputs
  // para que dois filhos em paralelo não sobrescrevam arquivos com o mesmo nome
  // E para que a interface consiga rotular cada arquivo com quem o produziu.
  const sandboxOptions = inherited
    ? { ...inherited.sandboxOptions, model: chosenModel, ...(outputsSubdir ? { outputsSubdir } : {}) }
    : {
      ...(developerContext?.sandboxOptions || { readOnlyPc: !pcWriteAuthorized }),
      userId,
      model: chosenModel,
      networkEnabled: sandboxNetworkEnabled,
      pcWriteAuthorized,
      ...(outputsSubdir ? { outputsSubdir } : {})
    };
  const webSearchActive = Boolean(webSearch && !lowSignalTurn);
  let requestedTools = toolsFor(assistant);
  if (developerContext?.readOnlyProject) requestedTools = requestedTools.filter(tool => !['write_file', 'zip_outputs', 'generate_image'].includes(tool.function.name));
  if (webSearchActive) requestedTools = [...requestedTools, ...webToolDefinitions];
  // Conector GitHub: UMA decisão, em `githubAccess.js` (o pré-voo `githubState`
  // acima). O inventário sai dele e a nota do prompt lê o MESMO objeto — assim o
  // que o modelo acredita ter e o que o executor tem nunca divergem.
  const githubTools = githubToolsForContext(githubState);
  // Uma nota, montada a partir do pré-voo, reaproveitada em toda reconstrução da
  // mensagem de inventário (fallback sem ferramentas, fim da pesquisa web, troca
  // de modelo). Sem isto, o estado da publicação sumia do prompt no meio do run.
  const githubNote = githubPreflightNote(githubState);
  if (githubTools.length) requestedTools = [...requestedTools, ...githubTools];
  if (lowSignalTurn) requestedTools = [];
  // TETO DO PAI. O filho monta a lista dele a partir do perfil do especialista;
  // aqui ela é podada pelas ferramentas que o PAI de fato tinha. Sem esta poda,
  // um assistente com apenas `read_file` delegava e o filho recebia o conjunto
  // padrão inteiro — `bash`, `run_python`, `write_file` — ou seja, delegar
  // virava um jeito de contornar a configuração do assistente.
  if (inherited) requestedTools = intersectToolDefinitions(requestedTools, inherited.allowedToolNames);
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
  if (subagentsOffered) {
    // A definição vai com o INVENTÁRIO real de assistentes desta conta: o modelo
    // escolhe um id que existe em vez de inventar "Fiscal" ou "Revisor".
    requestedTools = [...requestedTools, subagentToolDefinitionFor(await listSubagentSpecialists(userId))];
  }
  // PERGUNTAR AO USUÁRIO: ferramenta interna, interceptada antes do runTool (não
  // roda no sandbox, não toca arquivo nem rede). Fora para sub-agente (o filho
  // não fala com a pessoa) e para tarefa de segundo plano (não há quem responda).
  const askUserOffered = shouldOfferAskUser({
    lowSignalTurn,
    isSubagent,
    forceExecution: forceExecution || interactive === false,
    hasTools: requestedTools.length > 0
  });
  if (askUserOffered) requestedTools = [...requestedTools, askUserToolDefinition];
  // PLANO VISÍVEL (Fase 8): ferramenta interna, interceptada antes do runTool.
  // Só na missão de desenvolvimento do agente principal — o plano é da tarefa.
  const updatePlanOffered = shouldOfferUpdatePlan({
    developerContext,
    isSubagent,
    lowSignalTurn,
    hasTools: requestedTools.length > 0
  });
  if (updatePlanOffered) requestedTools = [...requestedTools, updatePlanToolDefinition];
  const subagentBudget = maxSubagentsPerRun();
  // Teto de delegações SIMULTÂNEAS (as do mesmo lote correm em paralelo).
  const delegationSlot = createSubagentLimiter();
  let subagentRuns = 0;
  // O lembrete de delegação entra UMA vez por execução (ver shouldNudgeSubagent).
  let subagentNudged = false;
  // F-25: ids de delegações iniciadas NESTE turno. O path dos arquivos que o
  // sub-agente escreveu começa com `outputs/<id>/` (runSubagent injeta o
  // `outputsSubdir = delegationId`). Quando o pai emite `files`, cada cartão
  // recebe `producer = <label>` se o path casa com o prefixo de uma delegação
  // conhecida. Sem isto, dois sub-agentes em paralelo sobrescrevem um ao
  // outro e a UI não tem como rotular.
  const subagentProducers = new Map(); // delegationId -> { label, prefix }
  // Fronteira de autorização da árvore: montada UMA vez, a partir do pedido real
  // do usuário, e entregue igual a toda delegação desta execução.
  const delegationContext = subagentsOffered
    ? buildDelegationContext({
      assistant,
      toolNames: requestedTools.map(tool => tool.function.name),
      sandboxOptions,
      developerContext,
      networkEnabled: sandboxNetworkEnabled,
      pcWriteAuthorized,
      commandGrants
    })
    : null;

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
  runState.to(developerContext ? 'planning' : 'analyzing', resume ? 'Retomando do checkpoint seguro' : 'Preparando a execução');

  // BYOK: sem chave de API configurada, orienta a cadastrar e encerra.
  if (!provider.hasKey) {
    // F-1: quando há chave mas o MODELO pedido não está em catálogo nenhum,
    // `getUserProvider` devolve o motivo em `attributionError`. Mostrar
    // "Nenhuma chave configurada" aqui seria repetir a mensagem enganosa do
    // PR #140 — o usuário TEM chave; o problema é outro, e ele precisa ler qual.
    const finalText = provider.attributionError
      ? provider.attributionError
      : freeTierConfigured()
        ? 'Nenhuma chave de API configurada. Você pode **começar gratuitamente** (Configurações → Provedor de IA → "Começar gratuitamente") ou cadastrar a sua própria chave (OpenRouter/DeepSeek) para conversar.'
        : 'Nenhuma chave de API configurada. Vá em **Configurações → Provedor de IA** e cadastre a sua chave (OpenRouter/DeepSeek) para começar a conversar.';
    onEvent({ type: 'status', content: 'Chave de API não configurada' });
    onEvent({ type: 'delta', content: finalText });
    const execution = runState.to('awaiting_user', 'Configuração do provedor necessária');
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
    const execution = runState.to('fatal_error', status, { compatibility: modelPlan.blocked.capability });
    if (!isSubagent) {
      const assistantMessageId = await saveMessage(userId, conversationId, 'assistant', finalText, { executionMeta: execution });
      onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId });
      indexAfterReply(userId, conversationId, chosenModel).catch(() => {});
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
    { role: 'system', content: toolAvailabilityNote(tools, { includeInventory: includeEnvironmentInventory, sandboxNetworkEnabled, githubNote }) }
  ];
  if (executionBriefing) messages.push({ role: 'user', content: untrustedContext('team-briefing', clipForBriefing(String(executionBriefing), BRIEFING_CHAR_LIMIT)) });
  if (environmentNote) messages.push({ role: 'user', content: untrustedContext('verified-environment-output', environmentNote) });
  if (developerContext?.userRules) messages.push({ role: 'user', content: untrustedContext('project-rules', developerContext.userRules) });
  const callNotes = [];
  // Reinício do sandbox entre turnos: o modelo precisa saber ANTES de agir. Sem
  // este aviso ele continua supondo que os pacotes instalados, os processos e os
  // arquivos temporários do turno anterior ainda existem — e retrabalha ou, pior,
  // conclui em cima de um estado que não está mais lá.
  const restartNotice = formatRestartNotice(takeSandboxRestartNotice(sandboxOptions.userId, conversationId));
  if (restartNotice) callNotes.push(restartNotice);
  // Transação de workspace aberta num turno anterior: sem este aviso, uma
  // alteração em vários arquivos fica pela metade em silêncio — ninguém confirma
  // nem desfaz, e o ponto de retorno vira lixo esquecido no disco.
  const openTransaction = formatOpenTransactionNotice(sandboxOpenTransaction(sandboxOptions.userId, conversationId));
  if (openTransaction) callNotes.push(openTransaction);
  if (forceExecution || modelPlan.requirements.required) callNotes.push(EXECUTION_CONTRACT_NOTE);
  if (MACRO_REQUEST_RE.test(String(userText || ''))) callNotes.push(MACRO_LIMITATION_NOTE);
  if (lowSignalTurn) callNotes.push(LOW_SIGNAL_TURN_NOTE);
  if (developerContext) callNotes.push(developerContext.note);
  // O plano do Modo Desenvolvedor (PLAN_BEFORE, nos modos que escrevem) é onde o
  // modelo decide COMO atacar a tarefa — então é ali que a divisão do trabalho
  // precisa ser decidida, não depois. Só entra quando a delegação está mesmo
  // disponível nesta chamada.
  if (developerContext?.canWrite && subagentsOffered) callNotes.push(PLAN_DELEGATION_TOPIC);
  if (updatePlanOffered) callNotes.push(PLAN_TOOL_NOTE);
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
  // JANELA ISOLADA DO SUB-AGENTE. O prompt dele diz, em letras garrafais, "você
  // não vê o histórico desta conversa" — mas o filho roda com o MESMO
  // conversationId, então memória de longo prazo e histórico entravam do mesmo
  // jeito. Além de contradizer a instrução (o modelo lia ordens antigas e sem
  // relação com a subtarefa), isso anulava o motivo de delegar: a janela do
  // filho vinha tão cheia quanto a do pai. Aqui ele recebe só o prompt
  // protegido, a subtarefa e o manifesto de arquivos/uploads da conversa — o
  // que o pai quiser que ele saiba tem de estar ESCRITO na subtarefa.
  if (isSubagent) {
    onEvent({ type: 'memory_context', memory: { isolated: true, reason: 'subagent' } });
  } else {
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
  // Histórico da conversa: o sub-agente não recebe nenhum (ver acima).
  const historyPlan = isSubagent
    ? { rows: [], meta: null }
    : await selectHistoryForContext({
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
    messages[1] = { role: 'system', content: toolAvailabilityNote(tools, { includeInventory: includeEnvironmentInventory, sandboxNetworkEnabled, githubNote }) };
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
  let hardMaxSteps = Math.max(maxSteps, Number(process.env.AGENT_HARD_MAX_STEPS) || Math.round(maxSteps * 1.5));
  // F-24: orçamento próprio do sub-agente (tempo, etapas, tokens). Sem isto,
  // o filho pode herdar o teto cheio do pai e queimar minutos de chave em
  // uma subtarefa que não era crítica. O pai passa o objeto via parâmetro;
  // defaults sensatos aqui cobrem testes/chamadas internas que esquecem.
  if (subagentRunBudget) {
    if (Number.isFinite(subagentRunBudget.maxSteps)) maxSteps = Math.min(maxSteps, subagentRunBudget.maxSteps);
    if (Number.isFinite(subagentRunBudget.hardMaxSteps)) hardMaxSteps = Math.min(hardMaxSteps, subagentRunBudget.hardMaxSteps);
  }
  // Deadline compartilhado: usado para garantir que filhos em paralelo não
  // estouram um limite global (ex.: 5 minutos totais para todas as
  // delegações deste turno).
  const deadlineMs = subagentRunBudget?.deadlineMs || null;
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
  // Solicitação estruturada de decisão do usuário (`ask_user`) ou, no fallback,
  // a pergunta que o modelo deixou no fim do texto. Vai para o evento SSE
  // `input_required` e para o `execution_meta` da mensagem — é o que permite à
  // interface reconstruir a pergunta depois de um reload ou de um replay.
  let inputRequest = null;
  // Última decisão `ask` da política de comandos: quando o modelo perguntar
  // (ask_user confirm), o backend carimba o escopo da autorização — o padrão da
  // política, nunca texto do modelo (mesmo desenho da publicação GitHub).
  let pendingCommandGrant = null;
  // PLANO ESTRUTURADO da tarefa (update_plan). Na retomada, o plano do run
  // interrompido volta do checkpoint e é reemitido para a interface remontar.
  let currentPlan = resume?.meta?.plan || null;
  if (currentPlan) onEvent({ type: 'plan_update', plan: currentPlan });
  // DOOM LOOP (Fase 46): mesma ferramenta + mesmos argumentos + mesmo resultado
  // repetidos viram bloqueio com instrução de mudar de estratégia.
  const doomLoop = createDoomLoopDetector();
  // Checkpoint: motivo da interrupção que JUSTIFICA salvar estado p/ retomar
  // (limite de ciclos, falha de provedor/stall exaurido, parada do usuário).
  // Falhas de QUALIDADE (degeneração, protocolo) NÃO viram checkpoint — ali o
  // certo é reenviar do zero, não continuar o mesmo array problemático.
  let checkpointReason = null;
  let reachedStep = 0;
  for (let step = 0; ; step++) {
    const windowStep = step - windowStart;
    // F-24: deadline compartilhado do sub-agente. Se passar do tempo total
    // alocado (soma das delegações paralelas), paramos mesmo que ainda haja
    // etapas — o pai não pode esperar infinitamente.
    if (deadlineMs && Date.now() >= deadlineMs) {
      incomplete = true;
      checkpointReason = 'deadline';
      // `deadlineMs` é um instante absoluto compartilhado entre as delegações
      // do turno; a mensagem informa o teto configurado (totalMs), não uma
      // conta com variáveis de outro escopo — a versão anterior referenciava
      // `startedAt`, que não existe aqui, e explodiria com ReferenceError na
      // primeira vez que o deadline fosse atingido.
      const totalSeconds = Math.round((subagentRunBudget?.totalMs || 0) / 1000);
      failureMessage = totalSeconds
        ? `A subtarefa atingiu o tempo limite de ${totalSeconds}s. Conclua com o que tem.`
        : 'A subtarefa atingiu o tempo limite. Conclua com o que tem.';
      break;
    }
    // F-24: teto de tokens do sub-agente. Impede que uma subtarefa queima a
    // chave em uma cadeia de resumos antes do pai perceber.
    if (subagentRunBudget?.maxTokens && usage.total_tokens >= subagentRunBudget.maxTokens) {
      incomplete = true;
      checkpointReason = 'token_budget';
      failureMessage = `A subtarefa atingiu o limite de ${subagentRunBudget.maxTokens} tokens. Conclua com o que tem.`;
      break;
    }
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
      runState.to('continuing', `Orçamento de etapas renovado (fôlego ${autoContinues})`, { step });
    }
    reachedStep = step;
    // LEMBRETE DE DELEGAÇÃO: numa execução que já se alongou, o modelo não
    // recebe sinal novo nenhum — e o contexto acumulado, que é exatamente o
    // custo que o sub-agente evita, só cresce. A nota vai no FIM do array (como
    // AUTO_CONTINUE_NOTE) para não invalidar o prefixo em cache.
    if (shouldNudgeSubagent({
      step: step - windowStart,
      offered: isToolCallAllowed(SUBAGENT_TOOL_NAME, tools),
      delegations: subagentRuns,
      budget: subagentBudget,
      alreadyNudged: subagentNudged
    })) {
      subagentNudged = true;
      messages.push({ role: 'system', content: SUBAGENT_NUDGE_NOTE });
    }
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
      messages[1] = { role: 'system', content: toolAvailabilityNote(tools, { sandboxNetworkEnabled, githubNote }) };
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
        messages[1] = { role: 'system', content: toolAvailabilityNote(tools, { sandboxNetworkEnabled, githubNote }) };
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
      awaitingUserReply = !forceExecution && interactive !== false && !missingClaimedOutput && endsAwaitingUserReply(content);
      // FALLBACK textual: o modelo perguntou no texto em vez de usar `ask_user`
      // (modelo pequeno, ou a ferramenta não estava na mesa). A interface recebe a
      // MESMA solicitação estruturada — kind 'text', marcada como `fallback` —
      // para o cartão de resposta aparecer nos dois caminhos.
      if (awaitingUserReply && !inputRequest) inputRequest = textInputRequest(content);
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
    // ANTES do laço, todas de uma vez (respeitando o teto de simultâneas). O
    // laço abaixo apenas AGUARDA a delegação quando chega a vez dela — assim os
    // resultados entram na ordem das tool_calls (o array de mensagens exige
    // esse pareamento), mas o tempo de parede é o da delegação mais lenta, não
    // a soma de todas.
    //
    // SÓ QUE ISSO É SEGURO APENAS EM LOTE HOMOGÊNEO. Num lote misto — um
    // `write_file` criando o arquivo e um `delegar_subagente` mandando revisá-lo
    // — o filho começava ANTES da escrita e concluía que o arquivo não existe,
    // ou lia a versão anterior; duas execuções idênticas davam resultados
    // diferentes. Com ferramenta de escrita no meio, tudo volta a correr em
    // série, na ordem em que o modelo pediu.
    // F-24: budget de EXECUÇÃO computado UMA vez por turno e REUSADO em todas
    // as delegações (paralelas ou em série). O `deadlineMs` é o MESMO objeto
    // para todos os filhos — assim, se duas delegações rodam em paralelo e o
    // tempo total estoura, AMBAS param pelo mesmo relógio, não cada uma com
    // seu próprio (que daria o dobro do tempo). O `now` é capturado aqui, não
    // dentro de buildSubagentBudget, justamente para o deadline ser justo.
    // O nome `runBudget` evita colisão com o `subagentBudget` (contagem de
    // delegações) lá em cima.
    const runBudget = buildSubagentBudget({ now: Date.now() });
    const startDelegation = (call, delegationArgs) => {
      // F-25: no momento em que o sub-agente parte, registra o prefixo do path.
      // runSubagent propaga `outputsSubdir = call.id` para o filho, então os
      // arquivos dele caem em `outputs/<id>/`. O label é atualizado depois com
      // o nome real do especialista (resolvido dentro de runSubagent).
      //
      // O registro mora AQUI, e não solto no corpo do passo, porque `call` só
      // existe dentro dos laços que percorrem `stepToolCalls` — e os dois
      // caminhos de delegação (o lote paralelo e o sequencial) passam por esta
      // função. Fora dela, a referência a `call` derrubava o passo inteiro com
      // um ReferenceError, em QUALQUER execução com ferramenta.
      subagentProducers.set(call.id, { label: 'sub-agente', prefix: `outputs/${call.id}/` });
      return runSubagent({
        userId,
        conversationId,
        args: delegationArgs,
        model: chosenModel,
        effort,
        control,
        onEvent,
        depth: subagentDepth,
        webSearch: webSearchActive,
        delegationId: call.id,
        delegation: delegationContext,   // permissões, sandbox e escopo herdados
        budget: runBudget                // F-24: mesmo budget para todos os filhos
      });
    };
    const delegations = new Map();
    if (canLaunchDelegationsInParallel(stepToolCalls.map(call => call.function.name))) {
      for (const call of stepToolCalls) {
        if (!isToolCallAllowed(SUBAGENT_TOOL_NAME, tools) || subagentRuns >= subagentBudget) break;
        subagentRuns += 1;
        let delegationArgs = {};
        try { delegationArgs = JSON.parse(call.function.arguments || '{}'); } catch {}
        onEvent({ type: 'tool_start', id: call.id, name: SUBAGENT_TOOL_NAME, preview: String(delegationArgs.tarefa || '').slice(0, 400) });
        runState.to('tool_running', SUBAGENT_TOOL_NAME, { step, tool: SUBAGENT_TOOL_NAME });
        delegations.set(call.id, delegationSlot(() => startDelegation(call, delegationArgs)));
      }
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
      // ── update_plan: manutenção do plano visível, não execução ──────────────
      // Interceptada antes do runTool (como o ask_user): nada roda no sandbox.
      // Cada chamada substitui o plano; o evento vai ao stream e ao run log.
      if (name === UPDATE_PLAN_TOOL_NAME) {
        const normalized = isToolCallAllowed(name, tools)
          ? normalizePlanUpdate(args)
          : { error: 'Ferramenta não autorizada para esta chamada.' };
        if (normalized.error) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: normalized.error, code: 'PLAN_INVALID' }) });
        } else {
          currentPlan = normalized.plan;
          onEvent({ type: 'plan_update', plan: currentPlan });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, steps: currentPlan.steps.length }) });
        }
        continue;
      }
      // ── ask_user: pedido de DECISÃO, não execução ───────────────────────────
      // Interceptado ANTES de qualquer `tool_start`/`runTool`: nada roda no
      // sandbox, nada toca arquivo ou rede. Uma pergunta não é etapa de execução,
      // então também não vira cartão de ferramenta na interface.
      if (name === ASK_USER_TOOL_NAME) {
        const normalized = isToolCallAllowed(name, tools)
          ? normalizeInputRequest(args)
          : { error: 'Ferramenta não autorizada para esta chamada.' };
        if (normalized.error) {
          // O erro volta ao MODELO (não ao usuário): ele corrige a chamada na
          // etapa seguinte, como em qualquer outra ferramenta. Nunca mostramos
          // JSON de validação na conversa.
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: normalized.error, code: 'ASK_USER_INVALID' }) });
          continue;
        }
        if (inputRequest) {
          // Duas perguntas no mesmo lote: só a primeira válida vale. A segunda
          // recebe uma recusa explícita para o array de mensagens ficar íntegro.
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'Já existe uma pergunta pendente neste turno; aguarde a resposta do usuário.', code: 'ASK_USER_PENDING' }) });
          continue;
        }
        inputRequest = normalized.request;
        // CONFIRMAÇÃO DE PUBLICAÇÃO: quando o que falta é exatamente a
        // autorização do GitHub, o BACKEND carimba o escopo na solicitação
        // (repositório, branch, base e ações, tirados do vínculo — nunca do texto
        // do modelo). Ao confirmar, a interface registra a autorização
        // estruturada e as ferramentas de escrita entram no inventário do turno
        // seguinte. Sem isto, um "sim" solto não autoriza nada e o agente ficaria
        // preso no mesmo pedido.
        if (inputRequest.kind === 'confirm' && githubState.blockingReason === 'write_not_confirmed' && githubState.repository && githubState.branch) {
          inputRequest.authorize = {
            kind: 'github_write',
            repo: githubState.repository,
            branch: githubState.branch,
            base: githubState.base || null,
            actions: ['push', 'create_pr']
          };
        }
        // CONFIRMAÇÃO DE COMANDO (permissionPolicy): quando um comando caiu em
        // `ask` neste run, a pergunta de confirmação carrega o escopo carimbado
        // pelo BACKEND (o padrão da política, o comando e o motivo — nunca
        // texto livre do modelo). Ao confirmar, a interface registra o grant e
        // o turno seguinte chega com o padrão autorizado.
        if (inputRequest.kind === 'confirm' && !inputRequest.authorize && pendingCommandGrant) {
          inputRequest.authorize = {
            kind: 'command_grant',
            pattern: pendingCommandGrant.pattern,
            command: pendingCommandGrant.command,
            reason: pendingCommandGrant.reason
          };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, awaiting_user: true, request_id: inputRequest.id, note: 'A pergunta foi entregue ao usuário e o turno termina aqui. A resposta dele chega como a próxima mensagem da conversa.' }) });
        // Fecha as chamadas RESTANTES do lote: o assistant já foi empilhado com
        // todas as tool_calls, e um array sem o `tool` correspondente é inválido
        // para a API (a retomada do checkpoint falharia com 400).
        for (let k = callIdx + 1; k < stepToolCalls.length; k++) {
          const inFlight = delegations.get(stepToolCalls[k].id);
          if (inFlight) {
            const partial = await inFlight;
            if (partial?.usage) addUsage(usage, partial.usage);
            onEvent({ type: 'tool_result', id: stepToolCalls[k].id, name: SUBAGENT_TOOL_NAME, content: partial?.result?.slice(0, 2000) || '' });
          }
          messages.push({ role: 'tool', tool_call_id: stepToolCalls[k].id, content: JSON.stringify({ error: 'Não executada: o turno parou para o usuário responder a uma pergunta.', code: 'AWAITING_USER' }) });
        }
        break;
      }
      // As delegações já anunciaram o início ao serem lançadas (acima).
      if (!pendingDelegation) {
        onEvent({ type: 'tool_start', id: call.id, name, preview, ...(detail ? { detail } : {}) });
        runState.to('tool_running', name, { step, tool: name });
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
      // POLÍTICA DE COMANDOS (allow/ask/deny): avaliada ANTES do executor. Um
      // `deny` explica o motivo de política (as fronteiras duras do execGuard/
      // sandbox continuam valendo por baixo); um `ask` devolve
      // PERMISSION_REQUIRED instruindo o modelo a usar ask_user — a confirmação
      // do usuário vira autorização estruturada no turno seguinte.
      const shellPermission = (name === 'bash' && allowedToolCall)
        ? evaluateShellCommand(String(args.command || ''), { grants: commandGrants })
        : null;
      // Doom loop: avaliado para toda ferramenta EXECUTÁVEL (a delegação tem
      // orçamento próprio; ask_user/update_plan são interceptadas antes).
      const doom = (allowedToolCall && name !== SUBAGENT_TOOL_NAME)
        ? doomLoop.shouldBlock(name, call.function.arguments || '')
        : null;
      if (!allowedToolCall) {
        result = JSON.stringify({ error: 'Ferramenta não autorizada para esta chamada.', code: 'TOOL_NOT_ALLOWED', tool: name });
      } else if (shellPermission?.decision === 'deny') {
        result = JSON.stringify({
          error: `Comando bloqueado pela política de permissões (padrão "${shellPermission.rule.pattern}"): ${shellPermission.rule.reason}.`,
          code: 'PERMISSION_DENIED',
          pattern: shellPermission.rule.pattern
        });
      } else if (shellPermission?.decision === 'ask') {
        pendingCommandGrant = {
          pattern: shellPermission.rule.pattern,
          command: String(args.command || '').slice(0, 200),
          reason: shellPermission.rule.reason
        };
        result = JSON.stringify({
          error: `Este comando exige confirmação do usuário antes de executar (${shellPermission.rule.reason}). Use a ferramenta ask_user (tipo "confirm") explicando EXATAMENTE o comando e o efeito dele; se o usuário confirmar, o padrão "${shellPermission.rule.pattern}" fica autorizado para esta tarefa e você pode repetir o comando.`,
          code: 'PERMISSION_REQUIRED',
          pattern: shellPermission.rule.pattern
        });
      } else if (doom?.blocked) {
        // A repetição não executa: o modelo recebe o motivo e a instrução de
        // mudar de rota. O erro conta no freio de falhas consecutivas — quem
        // insiste em círculo encerra o run com a causa honesta.
        onEvent({ type: 'status', content: `Repetição sem progresso detectada em ${name}; pedindo mudança de estratégia.` });
        result = doomLoopResult(name, doom.repeats);
      } else if (isWebTool && webResearchStop) {
        result = JSON.stringify({ error: 'A pesquisa web já atingiu o limite desta tarefa. Conclua com as evidências obtidas.', code: 'WEB_RESEARCH_STOPPED' });
      } else if (repeatedFetch) {
        result = JSON.stringify({ error: 'Esta URL já foi consultada nesta tarefa. Use uma fonte nova ou conclua com as evidências obtidas.', code: 'DUPLICATE_WEB_FETCH', url: args.url });
      } else if (name === SUBAGENT_TOOL_NAME) {
        // Delegação: NÃO passa pelo runTool (o sub-agente não roda no sandbox —
        // ele é outro runAgent). Sem promessa já em voo, ou o lote é misto (e a
        // delegação roda AQUI, depois das ferramentas que vieram antes dela), ou
        // o teto desta execução foi alcançado — nesse caso devolve erro e o
        // modelo segue sem delegar, no estilo dos demais freios do loop.
        let delegationPromise = pendingDelegation;
        if (!delegationPromise) {
          if (subagentRuns >= subagentBudget) {
            result = JSON.stringify({ error: `O limite de ${subagentBudget} delegações desta tarefa foi alcançado. Conclua a subtarefa você mesmo.`, code: 'SUBAGENT_LIMIT' });
          } else {
            subagentRuns += 1;
            delegationPromise = startDelegation(call, args);
          }
        }
        if (delegationPromise) {
          const delegation = await delegationPromise;
          // A usage do filho entra na do pai — o custo real nunca some do painel.
          if (delegation.usage) addUsage(usage, delegation.usage);
          if (delegation.stopped) stopped = true;
          result = delegation.result;
          // F-25: atualiza o label do produtor com o nome real do especialista
          // (resolvido dentro de runSubagent e devolvido em `especialista`).
          // Sem isto, todos os cartões de sub-agente mostrariam "sub-agente"
          // genérico.
          try {
            const parsed = JSON.parse(result);
            if (parsed?.especialista && subagentProducers.has(call.id)) {
              subagentProducers.get(call.id).label = String(parsed.especialista);
            }
          } catch {}
        }
      } else {
        const activeTool = beginToolRequest(control);
        try {
          // Progresso ao vivo do comando: sem isto, um `pytest` de 40s é uma
          // barra parada — o usuário não sabe se está processando ou travado, e
          // o `tool_result` só chega no fim.
          result = await runTool(conversationId, name, args, sandboxOptions, {
            signal: activeTool.signal,
            onProgress: (p) => onEvent({ type: 'tool_progress', id: call.id, ...p })
          });
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
      // Alimenta o detector com o resultado REAL: resultado novo zera a
      // contagem (progresso legítimo); idêntico aproxima o bloqueio.
      if (doom) doomLoop.record(doom.key, result);
      executedToolCalls += 1;
      // A miniatura da página (web_fetch) vai num campo SEPARADO do stream: o
      // `content` é cortado em 2000 chars e o caminho poderia ficar de fora.
      let thumb = '';
      if (name === 'web_fetch') { try { thumb = JSON.parse(result).thumb || ''; } catch {} }
      onEvent({ type: 'tool_result', id: call.id, name, content: result.slice(0, 2000), ...(thumb ? { thumb } : {}) });
      runState.to('processing_result', name, { step, tool: name });
      // O `result` CRU segue para a interface e para a classificação de falha —
      // quem precisa dele intacto. Para o MODELO ele vai embrulhado: é texto de
      // terceiro (página, arquivo, README, saída de comando) e, sem a marca de
      // dado, era a entrada de injeção mais curta do app. O embrulho também
      // neutraliza protocolo textual de ferramenta escondido no resultado, que
      // o próprio loop converteria em execução real caso o modelo o repetisse.
      messages.push({ role: 'tool', tool_call_id: call.id, content: untrustedToolResult(name, result) });
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
    // O modelo pediu uma DECISÃO ao usuário: o turno acaba aqui, com estado
    // `awaiting_user` — nunca `execution_failed`. O texto útil que ele já havia
    // escrito é preservado; a pergunta entra no fim se ainda não estiver lá.
    if (inputRequest) {
      awaitingUserReply = true;
      completedNaturally = true;
      // Trabalho real já feito antes da pergunta merece checkpoint: quem confirma
      // "pode publicar" depois de dezenas de etapas não pode ter de recomeçar.
      if (executedToolCalls > 0) checkpointReason = 'awaiting_user';
      if (!finalText.trim()) {
        finalText = inputRequest.question;
        onEvent({ type: 'delta', content: finalText });
      } else if (!finalText.includes(inputRequest.question)) {
        const pergunta = `\n\n${inputRequest.question}`;
        finalText += pergunta;
        onEvent({ type: 'delta', content: pergunta });
      }
      onEvent({ type: 'input_required', request: inputRequest });
      runState.to('tool_waiting', 'Aguardando a resposta do usuário', { step });
      break;
    }
    runState.to('continuing', 'Resultado processado; escolhendo a próxima etapa', { step });
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
        meta: { safePoint: 'after_tool_batch', webSearch: Boolean(webSearch), effort: effort || null, developer: developer || null, assistantId: assistant?.id || null, ...(currentPlan ? { plan: currentPlan } : {}) }
      });
    }
    // Etapa produtiva: executou ferramenta(s) e a última não falhou em cadeia.
    // Serve de sinal para permitir passar do orçamento base (ver topo do loop).
    if (consecutiveFailures === 0) lastProductiveStep = step;
    if (webResearchStop && !webResearchConclusionAttempted) {
      webResearchConclusionAttempted = true;
      tools = tools.filter(tool => !WEB_TOOL_NAMES.has(tool.function.name));
      messages[1] = { role: 'system', content: toolAvailabilityNote(tools, { sandboxNetworkEnabled, githubNote }) };
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
    runState.to('validating', 'Validando os artefatos antes da entrega');
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
      meta: { webSearch: Boolean(webSearch), effort: effort || null, developer: developer || null, assistantId: assistant?.id || null, sandboxNetworkEnabled, prompt: promptManifest, ...(currentPlan ? { plan: currentPlan } : {}) }
    });
    // Avisa a interface AO VIVO que dá para retomar (sem esperar um reload):
    // o botão "Continuar" aparece na mensagem interrompida.
    if (resumable) onEvent({ type: 'resumable', value: true });
  } else if (ownsCheckpoint) {
    await clearCheckpoint(conversationId, userId);
  }
  const finalState = finalExecutionState({ stopped, awaitingUserReply, resumable, providerFailure, incomplete });
  // O fallback textual só é reconhecido no fim do stream; quando ele acontece, a
  // interface precisa do `input_required` também ao vivo (o `execution_meta`
  // cobre o reload e o replay).
  if (awaitingUserReply && inputRequest?.fallback) onEvent({ type: 'input_required', request: inputRequest });
  const execution = runState.to(finalState, failureMessage || null, {
    model: chosenModel,
    toolsExecuted: executedToolCalls,
    toolsAvailable: tools.map(tool => tool.function.name),
    sandboxNetworkEnabled,
    prompt: promptManifest,
    resumable,
    validation: checks,
    // Persistido junto da mensagem: é o que faz a pergunta sobreviver ao reload,
    // ao replay e à troca de conversa.
    ...(awaitingUserReply && inputRequest ? { inputRequest } : {}),
    // Plano final da tarefa: persiste com a mensagem para a interface remontar
    // o checklist ao reabrir a conversa (mesmo caminho do inputRequest).
    ...(currentPlan ? { plan: currentPlan } : {}),
    // Estado real da integração com o GitHub nesta execução (sem token, sem
    // segredo): a interface mostra a CAUSA de um bloqueio em vez de "a ferramenta
    // não está habilitada".
    ...(githubState.connected || githubState.repository ? { github: githubState } : {})
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
    // F-25: atribui cada cartão ao sub-agente que o produziu, comparando o
    // path com o prefixo registrado para cada delegação do turno. Arquivos
    // do próprio agente principal ficam sem `producer` (mantém o
    // comportamento atual). Compara SEM case-sensitivity porque o path pode
    // vir capitalizado de jeitos diferentes conforme o filesystem.
    if (persisted.cards.length && subagentProducers.size) {
      for (const card of persisted.cards) {
        const lowerPath = String(card.path || '').toLowerCase();
        for (const producer of subagentProducers.values()) {
          if (lowerPath.startsWith(producer.prefix.toLowerCase())) {
            card.producer = producer.label;
            break;
          }
        }
      }
    }
    if (persisted.cards.length) onEvent({ type: 'files', files: persisted.cards });
    if (Object.keys(checks).length) onEvent({ type: 'file_checks', checks });
    onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: msgId });
  }
  // Memória: indexa a troca e extrai fatos em segundo plano (não bloqueia)
  if (!stopped && shouldPersistReply) indexAfterReply(userId, conversationId, chosenModel).catch(() => {});
  return { text: finalText, usage, model: chosenModel, stopped, providerFailure, incomplete, failureMessage, resumable, execution, files: newFiles, checks, messageId: msgId };
  } finally {
    // Mantém a conversa marcada como ativa até o card de download ter sido
    // persistido e emitido. Isso impede uma exclusão concorrente de apagar o
    // pai da mensagem e quebrar a chave estrangeira no final da resposta.
    if (ownsControl) releaseConversationControl(conversationId, control);
  }
}
