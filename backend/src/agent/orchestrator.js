// Orquestrador (Modo Equipe): consulta os especialistas em paralelo, sintetiza
// os pareceres pelo coordenador e delega a execução real ao runAgent.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import { getUserProvider } from '../userProvider.js';
import { rawModelId } from '../modelRef.js';
import { db } from '../db.js';
import { buildContext } from '../memory/contextBuilder.js';
import { indexAfterReply } from '../memory/indexer.js';
import { isLowSignalTurn, LOW_SIGNAL_TURN_NOTE } from '../memory/retrievalPolicy.js';
import { detectToolRequirement, getModelProfile, supportsModelParameter } from '../modelCapabilities.js';
import { runAgent } from './loop.js';
import { AGENTS, clipForBriefing, PERSPECTIVE_CHAR_LIMIT, BRIEFING_CHAR_LIMIT, uploadsNote, developerTeamContextFor, protectedProfilePrompt } from './prompts.js';
import { STREAM_RECOVERY_LIMIT, STREAM_RESUME_NOTE, STREAM_PAUSE_RESUME_NOTE, isRetryableStreamError, openRouterRouting, retryDelay, addUsage, friendlyApiError, tagProviderError, applyPromptCache } from './provider.js';
import { guardStreamStall, PROVIDER_CONNECT_TIMEOUT_MS } from './streamGuard.js';
import { acquireConversationControl, releaseConversationControl, beginProviderRequest, releaseProviderRequest, controlInterruptReason, gate } from './control.js';
import { clientScopeFor, memoryNote, saveMessage } from './persistence.js';
import { untrustedContext } from './promptRegistry.js';
import { buildDocumentContext } from '../docling/context.js';

const TEAM_TOOL_AWARENESS = `CAPACIDADES DO APP:
O Frederico AI Studio tem sandbox com Python 3, bash, LibreOffice/soffice, ffmpeg, OCR/PDF, vetores headless, Chromium/Playwright/Xvfb, toolchains C/C++/Go/Rust/Java/.NET/Kotlin, ML leve em CPU, qualidade e diagnóstico, bancos/clients remotos, Node com toolchain frontend, geração de arquivos e ferramentas de imagem/web quando habilitadas. Docker/Compose, GPU e builds nativos Android/iOS continuam deliberadamente fora do sandbox.
No Modo Equipe, os especialistas individuais desta etapa NÃO executam ferramentas diretamente; eles analisam e orientam. Se a resposta final exigir arquivo, cálculo, conversão ou validação, indique claramente que isso deve ser executado pelas ferramentas do assistente principal.`;

// Orquestrador: aciona vários assistentes e um coordenador une as respostas
export async function runOrchestrator({ userId, conversationId, userText, model, assistants = [], executor = null, webSearch = false, effort, developer, onEvent, control: inheritedControl = null }) {
  const provider = await getUserProvider(userId, model);     // chave dona do coordenador
  const client = provider.client;                            // sombreia o cliente global
  // Ver runMultiModel: a rota pode adquirir o controle antes do LiveStream.
  const control = inheritedControl || acquireConversationControl(conversationId, userId);
  try {
  const userMsgId = await saveMessage(userId, conversationId, 'user', userText);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // MODO GRATUITO: o coordenador (e os membros, que herdam via member.model ||
  // coordModel) fica restrito à allowlist gratuita da plataforma.
  let coordModel = model && model.includes('::') ? model : (provider.modelRef || model);
  if (provider.source === 'free') {
    const allowed = provider.freeModels || [];
    if (!allowed.includes(coordModel)) coordModel = provider.modelRef;
    // Assistentes/executor com modelo próprio fora da allowlist herdam o
    // coordenador (member.model || coordModel) em vez de gastar modelo pago.
    // Conferimos TANTO o `model_ref` (novo, completo) quanto o `model` cru
    // (legado): sem isto, a referência nova nunca casaria com os items da
    // allowlist que são modelRefs (`free::xxx`).
    const inAllowlist = (a) => a && (allowed.includes(a.model_ref) || allowed.includes(a.model));
    assistants = assistants.map(a => inAllowlist(a) ? a : { ...a, model: null });
    if (executor && !inAllowlist(executor)) executor = { ...executor, model: null };
  }
  if (!provider.hasKey) {
    // F-1: modelo não atribuível ≠ conta sem chave. O motivo real vem em
    // `attributionError` (ver userProvider.js) e prevalece sobre a genérica.
    const finalText = provider.attributionError
      || 'Nenhuma chave de API configurada. Vá em **Configurações → Provedor de IA** e cadastre a sua chave para usar o Modo Equipe.';
    onEvent({ type: 'delta', content: finalText });
    const assistantMessageId = await saveMessage(userId, conversationId, 'assistant', finalText);
    onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId });
    return { text: finalText, usage, model: coordModel };
  }
  const lowSignalTurn = isLowSignalTurn(userText);
  const requirement = detectToolRequirement({
    userText,
    webSearch: Boolean(webSearch && !lowSignalTurn),
    developer: Boolean(developer && !lowSignalTurn),
    hasUploads: !lowSignalTurn && Boolean(uploadsNote(userId, conversationId))
  });
  // Modo desenvolvedor no Modo Equipe: os especialistas e o coordenador precisam
  // saber QUAL projeto/repositório está selecionado e que o app já tem acesso ao
  // GitHub — senão respondem "me mande o link do repositório". (A execução real
  // continua no executor, via runAgent, que clona e lê o código.)
  const developerTeamNote = !lowSignalTurn ? developerTeamContextFor(developer, userId) : null;
  const developerRules = String(developer?.rules || '').trim().slice(0, 6000);
  let memory = null;
  let memoryMeta = null;
  try {
    const contextPlan = await buildContext({ userId, conversationId, assistantId: null, clientScope: await clientScopeFor(userId, conversationId), userText, model: coordModel, developerDomain: developerTeamNote ? 'software' : null });
    memory = (contextPlan.blocks || []).join('\n\n') || null;
    memoryMeta = contextPlan.meta || null;
    if (memoryMeta) onEvent({ type: 'memory_context', memory: memoryMeta });
  }
  catch { memory = await memoryNote(userId, null, await clientScopeFor(userId, conversationId)); }
  // Conteúdo dos documentos já extraído pela camada Docling. Os especialistas
  // desta etapa NÃO executam ferramentas — sem este bloco eles opinariam sobre
  // um documento que nunca viram (mesma lacuna que a nota do repositório fechou
  // para o código). O executor continua recebendo o seu por runAgent.
  let documentContext = null;
  if (!lowSignalTurn) {
    try {
      const docCtx = await buildDocumentContext(userId, conversationId, { query: userText });
      documentContext = docCtx?.note || null;
    } catch (e) { console.error('[docling] contexto do Modo Equipe falhou:', e.message); }
  }
  // Histórico da conversa (a mensagem atual do usuário já foi salva — exclui ela).
  // Limites ampliados (antes 13 msgs × 600 chars): com o corte agressivo, um
  // documento longo colado no início da conversa ficava praticamente invisível
  // para os especialistas. Configurável por env.
  const TEAM_HISTORY_MSGS = Math.max(6, Number(process.env.TEAM_HISTORY_MSGS || 21));
  const TEAM_HISTORY_CHARS = Math.max(600, Number(process.env.TEAM_HISTORY_CHARS || 1600));
  const histRows = (await db.prepare(`
    SELECT role, content FROM (
      SELECT role, content, created_at, seq FROM messages
      WHERE conversation_id=? ORDER BY created_at DESC, seq DESC LIMIT ?
    ) sub ORDER BY created_at ASC, seq ASC`).all(conversationId, TEAM_HISTORY_MSGS)).slice(0, -1);
  const historyText = histRows.map(m => `${m.role === 'user' ? 'Usuário' : 'Equipe'}: ${String(m.content).slice(0, TEAM_HISTORY_CHARS)}`).join('\n');
  const isFollowUp = histRows.some(m => m.role === 'assistant');

  async function streamCoordinator(msgs) {
    let text = '';
    for (let attempt = 0; ; attempt++) {
      let segment = '';
      let activeRequest;
      try {
        activeRequest = beginProviderRequest(control);
        const stream = await client.chat.completions.create({ model: rawModelId(coordModel), messages: msgs, ...(supportsModelParameter(getModelProfile(coordModel), 'temperature') ? { temperature: 0.3 } : {}), ...openRouterRouting(false, provider.baseURL), stream: true, stream_options: { include_usage: true } }, { signal: activeRequest.signal, timeout: PROVIDER_CONNECT_TIMEOUT_MS });
        for await (const chunk of guardStreamStall(stream, { onStall: () => activeRequest.abort('stall') })) {
          if (await gate(control, onEvent)) { stopped = true; return text; }
          if (chunk.usage) addUsage(usage, chunk.usage);
          const d = chunk.choices?.[0]?.delta?.content || '';
          if (d) { segment += d; text += d; onEvent({ type: 'delta', content: d }); }
        }
        return text;
      } catch (err) {
        const interrupted = controlInterruptReason(control, activeRequest);
        if (interrupted === 'stop') {
          stopped = true;
          return text;
        }
        if (interrupted === 'pause') {
          if (segment) {
            msgs.push({ role: 'assistant', content: segment });
            msgs.push({ role: 'system', content: STREAM_PAUSE_RESUME_NOTE });
          }
          onEvent({ type: 'status', content: 'Pausado' });
          if (await gate(control, onEvent)) {
            stopped = true;
            return text;
          }
          attempt -= 1;
          continue;
        }
        if (!isRetryableStreamError(err) || attempt >= STREAM_RECOVERY_LIMIT) throw err;
        if (segment) {
          msgs.push({ role: 'assistant', content: segment });
          msgs.push({ role: 'system', content: STREAM_RESUME_NOTE });
        }
        onEvent({ type: 'status', content: `O provedor demorou para responder. Retomando (${attempt + 1}/${STREAM_RECOVERY_LIMIT})...` });
        await retryDelay(attempt + 1);
      } finally {
        releaseProviderRequest(control, activeRequest);
      }
    }
  }

  // Consulta um especialista. Diferente do caminho de agente único, aqui a
  // chamada é NÃO-streaming; antes, se a resposta batesse no teto de tokens do
  // modelo (finish_reason='length'), o parecer PARCIAL era usado em silêncio no
  // briefing/síntese. Agora detectamos o truncamento e continuamos de onde
  // parou (até 2 vezes); se ainda ficar cortado, devolvemos truncated=true para
  // o parecer ser marcado como incompleto — nunca mais silencioso.
  const TEAM_MEMBER_CONTINUATIONS = Math.max(0, Number(process.env.TEAM_MEMBER_CONTINUATIONS || 2));
  async function askTeamMember(member, baseMsgs) {
    const msgs = [...baseMsgs];
    const requestedMemberModel = member.model || coordModel;
    const memberProvider = await getUserProvider(userId, requestedMemberModel);
    const memberModel = requestedMemberModel.includes('::') ? requestedMemberModel : (memberProvider.modelRef || requestedMemberModel);
    if (!memberProvider.client) return { error: new Error('A credencial deste provedor não está mais disponível.') };
    const memberUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let text = '';
    let truncated = false;
    for (let round = 0; round <= TEAM_MEMBER_CONTINUATIONS; ) {
      if (await gate(control, onEvent)) return { stopped: true };
      const activeRequest = beginProviderRequest(control);
      let completion;
      try {
        completion = await memberProvider.client.chat.completions.create({ model: rawModelId(memberModel), messages: msgs, ...(supportsModelParameter(getModelProfile(memberModel), 'temperature') ? { temperature: 0.3 } : {}), ...openRouterRouting(false, memberProvider.baseURL) }, { signal: activeRequest.signal });
      } catch (err) {
        const interrupted = controlInterruptReason(control, activeRequest);
        if (interrupted === 'stop') return { stopped: true };
        if (interrupted === 'pause') {
          onEvent({ type: 'status', content: 'Pausado' });
          if (await gate(control, onEvent)) return { stopped: true };
          continue; // repete a mesma rodada após retomar
        }
        return { error: err, text, usage: memberUsage };
      } finally {
        releaseProviderRequest(control, activeRequest);
      }
      addUsage(memberUsage, completion.usage);
      const choice = completion.choices?.[0];
      const piece = choice?.message?.content || '';
      text += piece;
      if (String(choice?.finish_reason || '').toLowerCase() !== 'length') { truncated = false; break; }
      truncated = true;
      round += 1;
      if (round > TEAM_MEMBER_CONTINUATIONS) break; // ainda cortado após as tentativas
      msgs.push({ role: 'assistant', content: piece });
      msgs.push({ role: 'system', content: 'Sua resposta anterior foi cortada pelo limite do modelo. Continue exatamente de onde parou, sem repetir o que já escreveu.' });
    }
    return { text, usage: memberUsage, truncated };
  }

  async function executeTeamTask(perspectives) {
    const selectedExecutor = executor
      || assistants.find(a => /program|codigo|codex|desenvolv|document/i.test(`${a.name || ''} ${a.system_prompt || ''}`))
      || { name: 'Executor', emoji: 'code-2', model: coordModel, system_prompt: AGENTS.codigo.prompt, tools: [], personality: {} };
    const briefing = perspectives.length
      ? clipForBriefing(perspectives.map(p => `### ${p.emoji || ''} ${p.name}\n${clipForBriefing(String(p.text || ''), PERSPECTIVE_CHAR_LIMIT)}`).join('\n\n'), BRIEFING_CHAR_LIMIT)
      : 'Nenhum parecer adicional foi produzido. Execute o pedido original integralmente.';
    onEvent({ type: 'status', content: perspectives.length ? 'Equipe concluiu a análise. Executando a tarefa...' : 'Executando a tarefa solicitada...' });
    const result = await runAgent({
      userId,
      conversationId,
      userText,
      model,
      assistant: selectedExecutor,
      webSearch,
      effort,
      developer,
      onEvent,
      saveUserMessage: false,
       existingUserMessageId: userMsgId,
       executionBriefing: briefing,
       forceExecution: true,
       control
    });
    addUsage(usage, result.usage);
    return { ...result, usage };
  }

  // Regra determinística (zero custo): a equipe completa é consultada UMA vez
  // por conversa (na primeira mensagem). Depois, o coordenador continua sozinho
  // com o histórico e a memória. O usuário pode forçar nova consulta escrevendo
  // "consulte a equipe" (ou "consulte os especialistas") na mensagem.
  const forceConsult = /consult\w*\s+(a\s+|os\s+|o\s+)?(equipe|especialistas|time|todos)/i.test(userText);
  const consult = !lowSignalTurn && (!isFollowUp || forceConsult) && assistants.length > 0;

  let finalText = '';
  const perspectives = [];
  let stopped = false;

  if (!consult) {
    if (requirement.required) {
      try { return await executeTeamTask(perspectives); }
      finally { releaseConversationControl(conversationId, control); }
    }
    // Continuação: o coordenador responde direto, com histórico e memória
    onEvent({ type: 'status', content: 'Coordenador respondendo (equipe consultada no início da conversa — escreva "consulte a equipe" para nova rodada)...' });
    // Mensagem system única (mesma razão do loop.js: vários modelos tratam mal
    // uma pilha de mensagens system; consolidar preserva o breakpoint de cache).
    const directSections = [
      protectedProfilePrompt(lowSignalTurn
        ? LOW_SIGNAL_TURN_NOTE
        : 'Você coordena um time de assistentes especializados e a conversa já está rolando. Responda direto à nova mensagem, em português do Brasil, usando o histórico e a memória. Nada de se reapresentar, descrever o time ou repetir o que já foi combinado — é só continuar de onde parou, com naturalidade.'),
      TEAM_TOOL_AWARENESS
    ];
    if (developerTeamNote) directSections.push(developerTeamNote);
    const directMsgs = [{ role: 'system', content: directSections.join('\n\n') }];
    const directPrefixEnd = directMsgs.length; // antes de memória/histórico
    if (memory) directMsgs.push({ role: 'user', content: untrustedContext('memory', memory) });
    if (documentContext) directMsgs.push({ role: 'user', content: untrustedContext('document-content', documentContext) });
    if (developerRules) directMsgs.push({ role: 'user', content: untrustedContext('project-rules', developerRules) });
    for (const m of histRows) directMsgs.push({ role: m.role, content: String(m.content).slice(0, 2000) });
    directMsgs.push({ role: 'user', content: userText });
    applyPromptCache(directMsgs, coordModel, directPrefixEnd, provider.baseURL);
    try { finalText = await streamCoordinator(directMsgs); }
    catch (err) { finalText = `Não foi possível responder: ${friendlyApiError(tagProviderError(err, { providerName: provider.providerName, model: rawModelId(coordModel) }))}`; onEvent({ type: 'delta', content: finalText }); }
  } else {
    // Os especialistas são consultados EM PARALELO (antes era em série: a
    // latência somava e, sob carga, cada membro extra aumentava a janela para
    // timeout do provedor). Cada um é independente; a ordem dos pareceres segue
    // a ordem dos assistentes (Promise.all preserva). O pause/stop aborta todas
    // as chamadas em voo via o Set de requisições ativas do controle.
    if (await gate(control, onEvent)) { stopped = true; }
    else {
      onEvent({ type: 'status', content: `Consultando ${assistants.length} especialista(s) em paralelo...` });
      const results = await Promise.all(assistants.map(async (a) => {
        onEvent({ type: 'tool_start', name: a.name });
        const sys = protectedProfilePrompt(`${a.system_prompt || ''}\n\n${TEAM_TOOL_AWARENESS}\n\nVocê faz parte de um time que já está conversando com a pessoa. Olhe o histórico e traga só a sua visão de especialista sobre a nova mensagem, direto ao ponto — sem se apresentar e sem repetir o que o time já disse. Nesta etapa você não gera arquivos nem roda código.`);
        const msgs = [{ role: 'system', content: developerTeamNote ? `${sys}\n\n${developerTeamNote}` : sys }];
        const memberPrefixEnd = msgs.length; // antes de memória/histórico
        if (memory) msgs.push({ role: 'user', content: untrustedContext('memory', memory) });
        if (documentContext) msgs.push({ role: 'user', content: untrustedContext('document-content', documentContext) });
        if (developerRules) msgs.push({ role: 'user', content: untrustedContext('project-rules', developerRules) });
        if (historyText) msgs.push({ role: 'user', content: untrustedContext('conversation-history', historyText) });
        msgs.push({ role: 'user', content: userText });
        applyPromptCache(msgs, a.model || coordModel, memberPrefixEnd, provider.baseURL);
        return { a, memberResult: await askTeamMember(a, msgs) };
      }));
      for (const { a, memberResult } of results) {
        if (memberResult.stopped) { stopped = true; continue; }
        if (memberResult.error) {
          onEvent({ type: 'tool_result', name: a.name, content: `erro: ${friendlyApiError(memberResult.error)}` });
          continue;
        }
        addUsage(usage, memberResult.usage);
        const text = memberResult.truncated
          ? `${memberResult.text}\n\n_[parecer truncado pelo limite do modelo — pode estar incompleto]_`
          : memberResult.text;
        perspectives.push({ name: a.name, emoji: a.emoji, text });
        onEvent({ type: 'tool_result', name: a.name, content: text.slice(0, 600) });
      }
    }

    if (stopped || await gate(control, onEvent)) {
      onEvent({ type: 'status', content: 'Interrompido pelo usuário' });
      finalText = perspectives.length ? perspectives.map(p => `### ${p.emoji || ''} ${p.name}\n${p.text}`).join('\n\n') : '_Processamento interrompido pelo usuário._';
      onEvent({ type: 'delta', content: finalText });
      const stoppedMsgId = await saveMessage(userId, conversationId, 'assistant', finalText, { memoryMeta });
      onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: stoppedMsgId });
      releaseConversationControl(conversationId, control);
      return { text: finalText, usage, model: coordModel, stopped: true };
    }

    if (requirement.required) {
      try { return await executeTeamTask(perspectives); }
      finally { releaseConversationControl(conversationId, control); }
    }

    onEvent({ type: 'status', content: 'Compilando a resposta final da equipe...' });
    const combined = perspectives.map(p => `### ${p.emoji || ''} ${p.name}\n${p.text}`).join('\n\n');
    const synthMsgs = [
      { role: 'system', content: [
        protectedProfilePrompt('Você coordena um time de assistentes especializados, numa conversa em andamento. Junte as perspectivas abaixo em UMA resposta só, coesa e em português do Brasil, que responda direto à nova mensagem da pessoa. Sem se reapresentar, sem descrever o time e sem discurso — vá ao ponto. Use títulos por área quando ajudar e feche com um resumo prático.'),
        TEAM_TOOL_AWARENESS,
        ...(developerTeamNote ? [developerTeamNote] : [])
      ].join('\n\n') },
      ...(developerRules ? [{ role: 'user', content: untrustedContext('project-rules', developerRules) }] : []),
      ...(historyText ? [{ role: 'user', content: untrustedContext('conversation-history', historyText) }] : []),
      { role: 'user', content: userText },
      { role: 'user', content: untrustedContext('team-perspectives', combined) }
    ];
    const synthPrefixEnd = synthMsgs.findIndex(message => message.role !== 'system');
    applyPromptCache(synthMsgs, coordModel, synthPrefixEnd < 0 ? synthMsgs.length : synthPrefixEnd, provider.baseURL);
    try { finalText = await streamCoordinator(synthMsgs); }
    catch (err) { finalText = `Não foi possível compilar a resposta final: ${friendlyApiError(err)}`; onEvent({ type: 'delta', content: finalText }); }
  }
  try {
    if (stopped) {
      onEvent({ type: 'status', content: 'Interrompido pelo usuário' });
      if (!finalText.trim()) {
        finalText = '_Processamento interrompido pelo usuário._';
        onEvent({ type: 'delta', content: finalText });
      }
    } else if (!finalText.trim()) {
      finalText = 'Concluído.';
      onEvent({ type: 'delta', content: finalText });
    }
    const doneMsgId = await saveMessage(userId, conversationId, 'assistant', finalText, { memoryMeta });
    onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: doneMsgId });
    indexAfterReply(userId, conversationId, coordModel).catch(() => {});
    return { text: finalText, usage, model: coordModel, stopped };
  } finally {
    releaseConversationControl(conversationId, control);
  }
  } finally {
    releaseConversationControl(conversationId, control);
  }
}
