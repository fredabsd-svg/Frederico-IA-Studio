// Orquestrador (Modo Equipe): consulta os especialistas em paralelo, sintetiza
// os pareceres pelo coordenador e delega a execução real ao runAgent.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import { getUserProvider } from '../userProvider.js';
import { db } from '../db.js';
import { buildContext } from '../memory/contextBuilder.js';
import { indexAfterReply } from '../memory/indexer.js';
import { isLowSignalTurn, LOW_SIGNAL_TURN_NOTE } from '../memory/retrievalPolicy.js';
import { detectToolRequirement } from '../modelCapabilities.js';
import { runAgent } from './loop.js';
import { AGENTS, QUALITY_BAR, clipForBriefing, PERSPECTIVE_CHAR_LIMIT, BRIEFING_CHAR_LIMIT, uploadsNote } from './prompts.js';
import { STREAM_RECOVERY_LIMIT, STREAM_RESUME_NOTE, STREAM_PAUSE_RESUME_NOTE, isRetryableStreamError, openRouterRouting, retryDelay, addUsage, friendlyApiError } from './provider.js';
import { acquireConversationControl, releaseConversationControl, beginProviderRequest, releaseProviderRequest, controlInterruptReason, gate } from './control.js';
import { clientScopeFor, memoryNote, saveMessage } from './persistence.js';

const TEAM_TOOL_AWARENESS = `CAPACIDADES DO APP:
O Frederico AI Studio tem sandbox com Python 3.12, bash, LibreOffice/soffice, ffmpeg, OCR/PDF, vetores headless, Chromium/Playwright/Xvfb, toolchains C/C++/Go/Rust/Java/.NET/Kotlin, ML leve em CPU, qualidade e diagnóstico, bancos/clients remotos, Node com toolchain frontend, geração de arquivos e ferramentas de imagem/web quando habilitadas. Docker/Compose, GPU e builds nativos Android/iOS continuam deliberadamente fora do sandbox.
No Modo Equipe, os especialistas individuais desta etapa NÃO executam ferramentas diretamente; eles analisam e orientam. Se a resposta final exigir arquivo, cálculo, conversão ou validação, indique claramente que isso deve ser executado pelas ferramentas do assistente principal.`;

// Orquestrador: aciona vários assistentes e um coordenador une as respostas
export async function runOrchestrator({ userId, conversationId, userText, model, assistants = [], executor = null, webSearch = false, effort, developer, onEvent }) {
  const provider = await getUserProvider(userId);            // BYOK
  const client = provider.client;                            // sombreia o cliente global
  const control = acquireConversationControl(conversationId);
  try {
  const userMsgId = await saveMessage(userId, conversationId, 'user', userText);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const coordModel = model || provider.model;
  if (!provider.hasKey) {
    const finalText = 'Nenhuma chave de API configurada. Vá em **Configurações → Provedor de IA** e cadastre a sua chave para usar o Modo Equipe.';
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
    hasUploads: !lowSignalTurn && Boolean(uploadsNote(conversationId))
  });
  let memory = null;
  let memoryMeta = null;
  try {
    const contextPlan = await buildContext({ userId, conversationId, assistantId: null, clientScope: await clientScopeFor(userId, conversationId), userText, model: coordModel });
    memory = (contextPlan.blocks || []).join('\n\n') || null;
    memoryMeta = contextPlan.meta || null;
    if (memoryMeta) onEvent({ type: 'memory_context', memory: memoryMeta });
  }
  catch { memory = await memoryNote(userId, null, await clientScopeFor(userId, conversationId)); }
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
        const stream = await client.chat.completions.create({ model: coordModel, messages: msgs, temperature: 0.3, ...openRouterRouting(), stream: true, stream_options: { include_usage: true } }, { signal: activeRequest.signal });
        for await (const chunk of stream) {
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
    const memberUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let text = '';
    let truncated = false;
    for (let round = 0; round <= TEAM_MEMBER_CONTINUATIONS; ) {
      if (await gate(control, onEvent)) return { stopped: true };
      const activeRequest = beginProviderRequest(control);
      let completion;
      try {
        completion = await client.chat.completions.create({ model: member.model || coordModel, messages: msgs, temperature: 0.3, ...openRouterRouting() }, { signal: activeRequest.signal });
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
    const directMsgs = [
      { role: 'system', content: 'Você coordena um time de assistentes especializados e a conversa já está rolando. Responda direto à nova mensagem, em português do Brasil, usando o histórico e a memória. Nada de se reapresentar, descrever o time ou repetir o que já foi combinado — é só continuar de onde parou, com naturalidade.' }
    ];
    if (lowSignalTurn) directMsgs[0] = { role: 'system', content: LOW_SIGNAL_TURN_NOTE };
    directMsgs.push({ role: 'system', content: QUALITY_BAR });
    directMsgs.push({ role: 'system', content: TEAM_TOOL_AWARENESS });
    if (memory) directMsgs.push({ role: 'system', content: memory });
    for (const m of histRows) directMsgs.push({ role: m.role, content: String(m.content).slice(0, 2000) });
    directMsgs.push({ role: 'user', content: userText });
    try { finalText = await streamCoordinator(directMsgs); }
    catch (err) { finalText = `Não foi possível responder: ${friendlyApiError(err)}`; onEvent({ type: 'delta', content: finalText }); }
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
        const sys = `${a.system_prompt}\n\n${TEAM_TOOL_AWARENESS}\n\nVocê faz parte de um time que já está conversando com a pessoa. Olhe o histórico e traga só a sua visão de especialista sobre a nova mensagem, direto ao ponto — sem se apresentar e sem repetir o que o time já disse. Nesta etapa você não gera arquivos nem roda código.`;
        const msgs = [{ role: 'system', content: sys }];
        if (memory) msgs.push({ role: 'system', content: memory });
        msgs.push({ role: 'user', content: historyText ? `Histórico recente da conversa:\n${historyText}\n\nNOVA mensagem do usuário:\n${userText}` : userText });
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
      { role: 'system', content: 'Você coordena um time de assistentes especializados, numa conversa em andamento. Junte as perspectivas abaixo em UMA resposta só, coesa e em português do Brasil, que responda direto à nova mensagem da pessoa. Sem se reapresentar, sem descrever o time e sem discurso — vá ao ponto. Use títulos por área quando ajudar e feche com um resumo prático.' },
      { role: 'system', content: QUALITY_BAR },
      { role: 'system', content: TEAM_TOOL_AWARENESS },
      { role: 'user', content: `${historyText ? `Histórico recente:\n${historyText}\n\n` : ''}NOVA mensagem do usuário:\n${userText}\n\nPerspectivas da equipe:\n${combined}` }
    ];
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
    indexAfterReply(userId, conversationId).catch(() => {});
    return { text: finalText, usage, model: coordModel, stopped };
  } finally {
    releaseConversationControl(conversationId, control);
  }
  } finally {
    releaseConversationControl(conversationId, control);
  }
}
