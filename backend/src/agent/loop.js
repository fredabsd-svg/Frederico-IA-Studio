// Loop do agente (runAgent): a conversa de agente único, com streaming,
// ferramentas, reparos, failover de modelo e entrega de arquivos.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import { getUserProvider } from '../userProvider.js';
import { nanoid } from 'nanoid';
import { webToolDefinitions, runTool } from '../tools.js';
import { buildContext, historyBudgetForModel, selectHistoryForContext } from '../memory/contextBuilder.js';
import { indexAfterReply } from '../memory/indexer.js';
import { getSettings } from '../memory/memoryService.js';
import { isLowSignalTurn, LOW_SIGNAL_TURN_NOTE } from '../memory/retrievalPolicy.js';
import { buildModelCallPlan, isUnsupportedToolError, isUnsupportedVisionError, markModelCapabilityUnsupported, modelCompatibilityMessage } from '../modelCapabilities.js';
import { createToolProtocolStreamGuard, parseTextToolCalls, sanitizeToolProtocolText } from '../toolProtocol.js';
import { githubToolDefinitions, GITHUB_WRITE_TOOLS, hasGithubConnection } from '../connectors/github.js';
import { effortCfg, promptFor, toolsFor, temperatureFor, developerContextFor, toolAvailabilityNote, ENVIRONMENT_QUERY_RE, verifiedEnvironmentNote, pcFoldersNote, uploadsNote, clipForBriefing, BRIEFING_CHAR_LIMIT, QUALITY_BAR } from './prompts.js';
import { listOutputs, mentionsOutputPath, recoverAlternateOutputs, referencedOutputFiles, fileSignature, validateOutputs } from './outputs.js';
import { OUTPUT_DELIVERY_REPAIR_NOTE, MISSING_OUTPUT_NOTICE, EXECUTION_COMPLETION_REPAIR_NOTE, EXECUTION_INCOMPLETE_NOTICE, TOOL_PROTOCOL_REPAIR_NOTE, TOOL_PROTOCOL_FAILURE_NOTICE, RESPONSE_TRUNCATED_REPAIR_NOTE, RESPONSE_TRUNCATED_NOTICE, EXECUTION_CONTRACT_NOTE, MACRO_REQUEST_RE, MACRO_LIMITATION_NOTE, DEGEN_CHECK_STEP, looksDegenerate, shouldRepairOutputDelivery, shouldRepairExecution, shouldContinueAfterTruncation, materializeTextOutput } from './repair.js';
import { normalizeWebFetchUrl, classifyToolOutcome, webResearchStopReason, planToolCallBatch, WEB_TOOL_NAMES, webResearchFinalizationNote, WEB_RESEARCH_FETCH_LIMIT, TOOL_CALLS_PER_STEP_LIMIT } from './webResearch.js';
import { imageUploadParts, attachImagesToLastUserMessage, stripImagePartsFromMessages } from './vision.js';
import { STREAM_RECOVERY_LIMIT, STREAM_RESUME_NOTE, STREAM_PAUSE_RESUME_NOTE, PROVIDER_TIMEOUT_NOTICE, isRetryableStreamError, openRouterRouting, retryDelay, addUsage, applyPromptCache } from './provider.js';
import { acquireConversationControl, releaseConversationControl, beginProviderRequest, releaseProviderRequest, beginToolRequest, releaseToolRequest, controlInterruptReason, gate } from './control.js';
import { clientScopeFor, memoryNote, saveMessage, persistAssistantReply } from './persistence.js';

export async function runAgent({ userId, conversationId, userText, model, assistant, webSearch, effort, developer, onEvent, saveUserMessage = true, existingUserMessageId = null, executionBriefing = null, forceExecution = false, control: inheritedControl = null }) {
  const provider = await getUserProvider(userId);          // BYOK: chave do usuário
  const client = provider.client;                          // sombreia o cliente global
  let chosenModel = model || assistant?.model || provider.model;
  // FAILOVER (MM-04): se o provedor cair no meio da tarefa, antes o app só
  // repetia o MESMO modelo e desistia. Agora há uma cadeia de reserva — os
  // modelos de MODEL_FALLBACKS (env) e, por padrão, o modelo-base da conta —
  // acionada só quando o modelo escolhido falha de forma recuperável, sem
  // perder o trabalho já feito (as mensagens/ferramentas já executadas ficam).
  const fallbackChain = [
    ...String(process.env.MODEL_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean),
    ...(provider.model && provider.model !== chosenModel ? [provider.model] : [])
  ];
  const triedModels = new Set([chosenModel]);
  const nextFallbackModel = () => {
    for (const m of fallbackChain) if (m && !triedModels.has(m)) { triedModels.add(m); return m; }
    return null;
  };
  const chosenPrompt = promptFor(assistant);
  const eff = effortCfg(effort);
  const developerContext = developerContextFor(developer, userId);
  const lowSignalTurn = isLowSignalTurn(userText);
  // userId viaja junto: o sandbox monta só as pastas do PC DESTE usuário
  // (isolamento multi-tenant) e aplica o limite de sandboxes por usuário.
  const sandboxOptions = { ...(developerContext?.sandboxOptions || {}), userId };
  const webSearchActive = Boolean(webSearch && !lowSignalTurn);
  let requestedTools = toolsFor(assistant);
  if (developerContext?.readOnlyProject) requestedTools = requestedTools.filter(tool => !['write_file', 'zip_outputs', 'generate_image'].includes(tool.function.name));
  if (webSearchActive) requestedTools = [...requestedTools, ...webToolDefinitions];
  // Conector GitHub: as ferramentas github_* só são oferecidas a quem conectou
  // a conta (Configurações → Conectores). Em plan/review, as de escrita
  // (push/PR) ficam de fora — esses modos não alteram nada.
  if (!lowSignalTurn && await hasGithubConnection(userId)) {
    const githubTools = developerContext && developerContext.mode !== 'build'
      ? githubToolDefinitions.filter(tool => !GITHUB_WRITE_TOOLS.has(tool.function.name))
      : githubToolDefinitions;
    requestedTools = [...requestedTools, ...githubTools];
  }
  if (lowSignalTurn) requestedTools = [];

  const modelPlan = buildModelCallPlan({
    modelId: chosenModel,
    tools: requestedTools,
    userText,
    webSearch: webSearchActive,
    developer: Boolean(developerContext && !lowSignalTurn),
    hasUploads: !lowSignalTurn && Boolean(uploadsNote(conversationId)),
    reasoningEffort: eff.reasoning
  });
  let tools = modelPlan.tools;
  const reasoningEffort = modelPlan.reasoning;
  const temperature = temperatureFor(assistant?.personality);
  const control = inheritedControl || acquireConversationControl(conversationId);
  const ownsControl = !inheritedControl;
  try {
  const userMsgId = saveUserMessage || !existingUserMessageId
    ? await saveMessage(userId, conversationId, 'user', userText)
    : existingUserMessageId;

  // BYOK: sem chave de API configurada, orienta a cadastrar e encerra.
  if (!provider.hasKey) {
    const finalText = 'Nenhuma chave de API configurada. Vá em **Configurações → Provedor de IA** e cadastre a sua chave (OpenRouter/DeepSeek) para começar a conversar.';
    onEvent({ type: 'status', content: 'Chave de API não configurada' });
    onEvent({ type: 'delta', content: finalText });
    const assistantMessageId = await saveMessage(userId, conversationId, 'assistant', finalText);
    onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId });
    return { text: finalText, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, model: chosenModel, stopped: false };
  }

  if (modelPlan.blocked) {
    const finalText = modelCompatibilityMessage(modelPlan);
    const status = modelPlan.blocked.capability === 'tools'
      ? 'Este modelo nao executa ferramentas.'
      : 'Este modelo nao responde em texto.';
    onEvent({ type: 'status', content: status });
    onEvent({ type: 'delta', content: finalText });
    const assistantMessageId = await saveMessage(userId, conversationId, 'assistant', finalText);
    onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId });
    indexAfterReply(userId, conversationId).catch(() => {});
    return {
      text: finalText,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model: chosenModel,
      stopped: false,
      compatibility: modelPlan.blocked.capability
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
  // QUALITY_BAR entra como 3o item: o índice 1 é reservado (reescrito adiante
  // com a nota de ferramentas), então não pode ser deslocado.
  const messages = [
    { role: 'system', content: chosenPrompt },
    { role: 'system', content: toolAvailabilityNote(tools, { includeInventory: includeEnvironmentInventory }) },
    { role: 'system', content: QUALITY_BAR }
  ];
  if (forceExecution || modelPlan.requirements.required) messages.push({ role: 'system', content: EXECUTION_CONTRACT_NOTE });
  if (MACRO_REQUEST_RE.test(String(userText || ''))) messages.push({ role: 'system', content: MACRO_LIMITATION_NOTE });
  if (executionBriefing) messages.push({ role: 'system', content: `PARECERES DA EQUIPE PARA ORIENTAR A EXECUÇÃO (use como referência, mas confira tudo com as ferramentas):\n${clipForBriefing(String(executionBriefing), BRIEFING_CHAR_LIMIT)}` });
  if (lowSignalTurn) messages.push({ role: 'system', content: LOW_SIGNAL_TURN_NOTE });
  if (environmentNote) messages.push({ role: 'system', content: environmentNote });
  if (developerContext) messages.push({ role: 'system', content: developerContext.note });
  if (eff.nudge) messages.push({ role: 'system', content: eff.nudge });
  if (webSearchActive) messages.push({ role: 'system', content: `PESQUISA NA INTERNET — o usuário ativou a busca. Você tem acesso real à web, pelas ferramentas web_search (procurar) e web_fetch (abrir uma página). Nunca diga que "não tem acesso à internet".

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

O sandbox Python também tem internet: use requests/urllib ou uma API quando precisar de dados estruturados (para CNPJ, use a ferramenta consultar_cnpj). Use web_search/web_fetch para procurar e ler páginas.` });
  // Fim do preâmbulo ESTÁVEL (prompt-base + notas de sistema): tudo daqui pra
  // frente (memória, uploads, histórico) muda a cada turno. É o ponto natural
  // para o breakpoint de prompt caching.
  const staticPrefixEnd = messages.length;
  let memoryMeta = null;
  // Memória de longo prazo: perfil, notas, resumos e recuperação semântica
  try {
    const contextPlan = await buildContext({ userId, conversationId, assistantId: assistant?.id, clientScope: await clientScopeFor(userId, conversationId), userText, historyLimit, model: chosenModel });
    const ctxBlocks = contextPlan.blocks || [];
    memoryMeta = contextPlan.meta || null;
    for (const b of ctxBlocks) {
      const clean = sanitizeToolProtocolText(b);
      if (clean) messages.push({ role: 'system', content: clean });
    }
  } catch (err) {
    console.error('[memória] contexto indisponível nesta resposta:', err.message);
    const memory = await memoryNote(userId, assistant?.id, await clientScopeFor(userId, conversationId));
    const cleanMemory = sanitizeToolProtocolText(memory);
    if (cleanMemory) messages.push({ role: 'system', content: cleanMemory });
  }
  const note = uploadsNote(conversationId);
  if (note) messages.push({ role: 'system', content: note });
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

  // VISÃO MULTIMODAL: se o modelo escolhido tem visão e há imagens anexadas,
  // envia as imagens direto para o modelo (ele enxerga). Modelos SEM visão não
  // recebem as imagens aqui — continuam lendo por OCR no sandbox.
  let visionApplied = false;
  if (modelPlan.capabilities?.vision === true) {
    visionApplied = attachImagesToLastUserMessage(messages, imageUploadParts(conversationId));
    if (visionApplied) onEvent({ type: 'status', content: 'Enviando a imagem para o modelo analisar...' });
  }

  // Prompt caching: marca o prefixo estável para o provedor reaproveitá-lo nos
  // próximos passos/mensagens (economia de tokens de entrada + latência). No-op
  // quando o modelo/rota não suporta (ex.: DeepSeek direto já cacheia sozinho).
  applyPromptCache(messages, chosenModel, staticPrefixEnd);

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
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
  const executionRequired = forceExecution || modelPlan.requirements.required;
  const requiresOutput = modelPlan.requirements.expectsOutput;
  const outputsBefore = new Map(listOutputs(conversationId).map(f => [f.path, fileSignature(f)]));
  let finalText = '';
  let stopped = false;
  let completedNaturally = false;
  let consecutiveFailures = 0;
  let toolFallbackApplied = false;
  let executionRepairAttempted = false;
  let protocolRepairAttempted = false;
  let forceNativeToolCall = false;
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
  for (let step = 0; step < hardMaxSteps; step++) {
    // Passou do orçamento base? Só segue enquanto o trabalho ainda rende (uma
    // ferramenta executada com sucesso há poucas etapas). Se estagnou, encerra
    // como limite de etapas — as travas de falha (5 seguidas), repetição e
    // pesquisa web continuam valendo à parte.
    if (step >= maxSteps && (step - lastProductiveStep) >= IDLE_STEP_GRACE) break;
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
      stream = await client.chat.completions.create({
        model: chosenModel,
        messages,
        ...(tools.length ? { tools, tool_choice: forceNativeToolCall ? 'required' : 'auto' } : {}),
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        temperature,
        ...openRouterRouting(tools.length > 0),
        stream: true,
        stream_options: { include_usage: true }
      }, { signal: activeRequest.signal });
    } catch (err) {
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
      if (!isUnsupportedToolError(err) || !tools.length || toolFallbackApplied) {
        if (isRetryableStreamError(err) && streamRecoveryAttempts < STREAM_RECOVERY_LIMIT) {
          streamRecoveryAttempts += 1;
          onEvent({ type: 'status', content: `O provedor demorou para responder. Tentando novamente (${streamRecoveryAttempts}/${STREAM_RECOVERY_LIMIT})...` });
          await retryDelay(streamRecoveryAttempts);
          step -= 1;
          continue;
        }
        if (isRetryableStreamError(err)) {
          const fb = nextFallbackModel();
          if (fb) {
            onEvent({ type: 'status', content: `O provedor falhou com ${chosenModel}. Tentando o modelo de reserva ${fb}...` });
            chosenModel = fb;
            streamRecoveryAttempts = 0;
            step -= 1;
            continue;
          }
          providerFailure = true;
          failureMessage = 'O provedor do modelo ficou indisponível antes de concluir a tarefa.';
          finalText += PROVIDER_TIMEOUT_NOTICE;
          onEvent({ type: 'delta', content: PROVIDER_TIMEOUT_NOTICE });
          completedNaturally = true;
          break;
        }
        throw err;
      }
      const profile = markModelCapabilityUnsupported(chosenModel, 'tools') || modelPlan.profile;
      if (modelPlan.requirements.required) {
        const unavailablePlan = { ...modelPlan, profile, capabilities: profile.capabilities, blocked: { capability: 'tools' } };
        finalText = modelCompatibilityMessage(unavailablePlan);
        onEvent({ type: 'status', content: 'Este modelo não executa ferramentas.' });
        onEvent({ type: 'delta', content: finalText });
        completedNaturally = true;
        break;
      }
      toolFallbackApplied = true;
      tools = [];
      messages[1] = { role: 'system', content: toolAvailabilityNote(tools) };
      onEvent({ type: 'status', content: 'Este modelo não oferece ferramentas; respondendo em texto.' });
      step -= 1;
      continue;
    }
    let reasoningNotified = false;
    let pausedDuringStream = false;
    try {
    for await (const chunk of stream) {
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
        const fb = nextFallbackModel();
        if (fb) {
          if (content || toolCalls.filter(Boolean).length) {
            messages.push({ role: 'assistant', content: sanitizeToolProtocolText(content) });
            messages.push({ role: 'system', content: STREAM_RESUME_NOTE });
          }
          onEvent({ type: 'status', content: `Falha no provedor com ${chosenModel}. Continuando com o modelo de reserva ${fb}...` });
          chosenModel = fb;
          streamRecoveryAttempts = 0;
          step -= 1;
          continue;
        }
        finalText += PROVIDER_TIMEOUT_NOTICE;
        providerFailure = true;
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
        messages[1] = { role: 'system', content: toolAvailabilityNote(tools) };
        messages.push({ role: 'system', content: webResearchFinalizationNote(webResearchStop) });
        onEvent({ type: 'status', content: 'Reunindo o que encontrei e cruzando as fontes...' });
        step -= 1;
        continue;
      }
      const outputsSoFar = listOutputs(conversationId);
      if (shouldContinueAfterTruncation(finishReason, truncationContinuationAttempts)) {
        truncationContinuationAttempts += 1;
        messages.push({ role: 'system', content: RESPONSE_TRUNCATED_REPAIR_NOTE });
        onEvent({ type: 'status', content: 'Continuando uma resposta que foi cortada...' });
        continue;
      }
      const missingClaimedOutput = shouldRepairOutputDelivery(content, outputsBefore, outputsSoFar);
      const incompleteExecution = shouldRepairExecution({
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
    for (const call of stepToolCalls) {
      if (await gate(control, onEvent)) { stopped = true; break; }
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      // Prévia do que a ferramenta vai executar (exibida na interface)
      const preview = String(args.code || args.command || args.prompt || args.path || args.query || args.url || '').slice(0, 400);
      // Prévia rica p/ o Ambiente de Trabalho: ao gravar arquivo, manda também o
      // conteúdo escrito (o resultado só traz o caminho) para o painel de detalhe
      // mostrar o que a IA de fato salvou. Limitado para não pesar no stream.
      const detail = name === 'write_file' ? String(args.content || '').slice(0, 4000) : '';
      onEvent({ type: 'tool_start', name, preview, ...(detail ? { detail } : {}) });
      let result;
      const isWebTool = name === 'web_search' || name === 'web_fetch';
      const fetchUrl = name === 'web_fetch' ? normalizeWebFetchUrl(args.url) : '';
      const repeatedFetch = Boolean(fetchUrl && seenWebFetches.has(fetchUrl));
      if (name === 'web_fetch' && !repeatedFetch) {
        if (fetchUrl) seenWebFetches.add(fetchUrl);
        webFetchAttempts += 1;
      }
      if (isWebTool && webResearchStop) {
        result = JSON.stringify({ error: 'A pesquisa web já atingiu o limite desta tarefa. Conclua com as evidências obtidas.', code: 'WEB_RESEARCH_STOPPED' });
      } else if (repeatedFetch) {
        result = JSON.stringify({ error: 'Esta URL já foi consultada nesta tarefa. Use uma fonte nova ou conclua com as evidências obtidas.', code: 'DUPLICATE_WEB_FETCH', url: args.url });
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
      onEvent({ type: 'tool_result', name, content: result.slice(0, 2000), ...(thumb ? { thumb } : {}) });
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
    // Etapa produtiva: executou ferramenta(s) e a última não falhou em cadeia.
    // Serve de sinal para permitir passar do orçamento base (ver topo do loop).
    if (consecutiveFailures === 0) lastProductiveStep = step;
    if (webResearchStop && !webResearchConclusionAttempted) {
      webResearchConclusionAttempted = true;
      tools = tools.filter(tool => !WEB_TOOL_NAMES.has(tool.function.name));
      messages[1] = { role: 'system', content: toolAvailabilityNote(tools) };
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
  }
  else if (!completedNaturally) {
    incomplete = true;
    failureMessage = `A tarefa atingiu o limite de ${hardMaxSteps} etapas antes da conclusão.`;
    // Atingiu o limite de etapas ainda usando ferramentas: avisa de forma honesta
    // e diz como retomar. NÃO presuma que era extração de dados — pode ser
    // programação, pesquisa etc.; a mensagem antiga sugeria CSV sem cabimento.
    const note = `\n\n_⚠️ Esta tarefa ficou longa e precisei pausá-la para não rodar sem fim. O que já consegui fazer está acima. Toque em **Reenviar** para eu continuar de onde parei; se for algo grande, ajuda dividir em etapas menores (ex.: primeiro investigar/planejar, depois executar por partes)._`;
    finalText += note;
    onEvent({ type: 'delta', content: note });
  }
  // Detecta os arquivos gerados NESTA resposta e os anexa à mensagem
  let outputsAfter = listOutputs(conversationId);
  let newFiles = outputsAfter.filter(f => outputsBefore.get(f.path) !== fileSignature(f));
  if (!newFiles.length && mentionsOutputPath(finalText)) {
    await recoverAlternateOutputs(conversationId, sandboxOptions);
    outputsAfter = listOutputs(conversationId);
    newFiles = outputsAfter.filter(f => outputsBefore.get(f.path) !== fileSignature(f));
  }
  if (!newFiles.length && mentionsOutputPath(finalText)) newFiles = referencedOutputFiles(finalText, outputsAfter);
  if (!newFiles.length && mentionsOutputPath(finalText) && materializeTextOutput(conversationId, finalText)) {
    outputsAfter = listOutputs(conversationId);
    newFiles = outputsAfter.filter(f => outputsBefore.get(f.path) !== fileSignature(f));
  }
  if (!newFiles.length && (requiresOutput || mentionsOutputPath(finalText))) {
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
  // Primeiro registra a resposta e os arquivos juntos. Assim o card sempre
  // aponta para uma mensagem que sobreviverá ao recarregamento da conversa.
  const { msgId, cards } = await persistAssistantReply(userId, conversationId, finalText, memoryMeta, newFiles);
  // O download é a entrega principal. Não o faça esperar a inspeção de DOCX,
  // XLSX ou PDF, que pode levar alguns segundos em arquivos maiores.
  if (cards.length) onEvent({ type: 'files', files: cards });
  // Informa os ids reais salvos no banco (necessário para editar mensagens)
  onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: msgId });
  if (newFiles.length && !stopped) {
    const checks = await validateOutputs(conversationId, newFiles, onEvent, sandboxOptions);
    if (Object.keys(checks).length) onEvent({ type: 'file_checks', checks });
  }
  // Memória: indexa a troca e extrai fatos em segundo plano (não bloqueia)
  if (!stopped) indexAfterReply(userId, conversationId).catch(() => {});
  return { text: finalText, usage, model: chosenModel, stopped, providerFailure, incomplete, failureMessage };
  } finally {
    // Mantém a conversa marcada como ativa até o card de download ter sido
    // persistido e emitido. Isso impede uma exclusão concorrente de apagar o
    // pai da mensagem e quebrar a chave estrangeira no final da resposta.
    if (ownsControl) releaseConversationControl(conversationId, control);
  }
}
