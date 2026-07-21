// Orquestrador MULTIMODELO: dois ou mais MODELOS de IA trabalham na MESMA
// mensagem, cada um com uma função (papel) própria. Diferente do Modo Equipe
// (orchestrator.js), em que vários ASSISTENTES usam o mesmo modelo, aqui cada
// participante é uma chamada independente a um modelo distinto do provedor.
//
// Modos de colaboração:
//   compare  — todos respondem em paralelo; as respostas ficam lado a lado.
//   council  — todos respondem em paralelo e um coordenador consolida
//              (concordâncias, divergências, erros e resposta final).
//   debate   — rodadas controladas: cada modelo lê as respostas dos outros,
//              critica e revisa a própria; o coordenador fecha.
//   pipeline — execução sequencial (especialistas): cada modelo recebe o que os
//              anteriores produziram; o último entrega a resposta final. No
//              Modo Desenvolvedor, a etapa "implementador" executa de verdade
//              via runAgent (ferramentas/sandbox) e as etapas seguintes revisam.
//
// Fallback NÃO é multimodelo: aqui todos os modelos selecionados são de fato
// executados e produzem resposta própria (ver docs — seção 15 do pedido).
import { getUserProvider } from '../userProvider.js';
import { db } from '../db.js';
import { getModelProfile } from '../modelCapabilities.js';
import { indexAfterReply } from '../memory/indexer.js';
import { runAgent } from './loop.js';
import { clipForBriefing } from './prompts.js';
import { STREAM_RECOVERY_LIMIT, STREAM_RESUME_NOTE, STREAM_PAUSE_RESUME_NOTE, isRetryableStreamError, openRouterRouting, retryDelay, addUsage, friendlyApiError, applyPromptCache } from './provider.js';
import { guardStreamStall, PROVIDER_CONNECT_TIMEOUT_MS } from './streamGuard.js';
import { acquireConversationControl, releaseConversationControl, beginProviderRequest, releaseProviderRequest, controlInterruptReason, gate } from './control.js';
import { saveMessage } from './persistence.js';

export const MULTI_MODES = ['compare', 'council', 'debate', 'pipeline'];
export const MULTI_CONTEXTS = ['full', 'recent', 'summary', 'none'];
export const MULTI_MAX_MODELS = Math.max(2, Number(process.env.MULTI_MAX_MODELS || 6));
export const MULTI_MAX_ROUNDS = Math.max(1, Number(process.env.MULTI_MAX_ROUNDS || 3));

// Funções (papéis) prontas. O usuário também pode escrever um prompt próprio
// por participante (member.prompt), que tem prioridade sobre o papel.
export const MULTI_ROLES = {
  principal:    { label: 'Modelo principal',        prompt: 'Você é o modelo principal desta tarefa. Responda ao pedido do usuário da forma mais completa, correta e útil possível.' },
  revisor:      { label: 'Revisor crítico',         prompt: 'Você é um revisor crítico. Analise o pedido (e as respostas dos outros modelos, quando fornecidas) procurando erros, omissões, riscos e afirmações sem fundamento. Seja específico e construtivo.' },
  pesquisador:  { label: 'Pesquisador',             prompt: 'Você é um pesquisador. Levante os fatos, dados, definições e referências relevantes para o pedido, separando o que é certo do que é incerto.' },
  codigo:       { label: 'Especialista em código',  prompt: 'Você é um especialista em programação. Concentre-se na parte técnica: código correto, casos de borda, desempenho e boas práticas.' },
  arquiteto:    { label: 'Arquiteto de software',   prompt: 'Você é um arquiteto de software. Analise o pedido e o contexto do projeto e produza um plano de implementação claro: etapas, arquivos afetados, riscos e critérios de aceite.' },
  implementador:{ label: 'Implementador',           prompt: 'Você é o implementador. Execute o plano recebido e produza a solução concreta (código, alterações, entregáveis), explicando o que fez.' },
  seguranca:    { label: 'Especialista em segurança', prompt: 'Você é um especialista em segurança. Verifique vulnerabilidades, exposição de credenciais, permissões, validação de entrada e riscos da solução proposta.' },
  testador:     { label: 'Testador',                prompt: 'Você é o responsável pelos testes. Verifique se a solução atende ao pedido, aponte casos de teste importantes e possíveis falhas de comportamento.' },
  tributario:   { label: 'Especialista tributário', prompt: 'Você é um especialista tributário brasileiro. Analise o pedido sob a ótica de tributos, obrigações acessórias e enquadramentos, citando a base legal quando possível.' },
  contabil:     { label: 'Especialista contábil',   prompt: 'Você é um especialista contábil brasileiro. Analise lançamentos, demonstrações, classificação e efeitos contábeis do que foi pedido.' },
  juridico:     { label: 'Especialista jurídico',   prompt: 'Você é um especialista jurídico brasileiro. Analise riscos legais, contratos, obrigações e a fundamentação normativa aplicável.' },
  coordenador:  { label: 'Coordenador',             prompt: 'Você é o coordenador. Compare as contribuições, identifique concordâncias e divergências, descarte erros e produza a resposta final consolidada.' },
  livre:        { label: 'Função personalizada',    prompt: 'Contribua com a sua análise sobre o pedido do usuário, de forma direta e útil.' }
};

const STATUS = {
  waiting: 'aguardando',
  thinking: 'analisando',
  answering: 'respondendo',
  reviewing: 'revisando',
  done: 'concluido',
  stopped: 'interrompido',
  error: 'erro'
};

const META_TEXT_LIMIT = 20000;

// ---- Normalização/validação da configuração vinda do frontend ----
// Devolve null quando a configuração não caracteriza uma execução multimodelo
// de verdade (menos de 2 modelos válidos) — o chamador então segue no fluxo
// normal de um modelo só.
export function normalizeMultiModelConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = MULTI_MODES.includes(raw.mode) ? raw.mode : 'compare';
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .map(m => {
      const id = String(m?.id || '').trim();
      if (!id || id.length > 200) return null;
      const role = MULTI_ROLES[m?.role] ? m.role : 'livre';
      const prompt = typeof m?.prompt === 'string' ? m.prompt.trim().slice(0, 4000) : '';
      const label = typeof m?.label === 'string' ? m.label.trim().slice(0, 80) : '';
      return { id, role, prompt: prompt || null, label: label || null };
    })
    .filter(Boolean)
    .slice(0, MULTI_MAX_MODELS);
  if (models.length < 2) return null;
  const coordinator = String(raw.coordinator || '').trim().slice(0, 200) || models[0].id;
  const rounds = Math.min(MULTI_MAX_ROUNDS, Math.max(1, Number.parseInt(raw.rounds, 10) || 2));
  const maxTokensRaw = Number.parseInt(raw.maxTokensPerModel, 10);
  const maxTokensPerModel = Number.isFinite(maxTokensRaw) ? Math.min(32000, Math.max(256, maxTokensRaw)) : null;
  const budgetRaw = Number(raw.budgetUsd);
  const budgetUsd = Number.isFinite(budgetRaw) && budgetRaw > 0 ? Math.min(1000, budgetRaw) : null;
  const context = MULTI_CONTEXTS.includes(raw.context) ? raw.context : 'recent';
  return { mode, models, coordinator, rounds, maxTokensPerModel, budgetUsd, context };
}

// Custo em USD de um uso, com os preços por token do catálogo do provedor.
// Sem preço no catálogo (catálogo ainda não carregado, modelo desconhecido),
// devolve null — a interface mostra "—" em vez de um zero enganoso.
export function usageCostUsd(modelId, usage) {
  if (!usage) return null;
  const profile = getModelProfile(modelId);
  const priceIn = Number(profile?.price || 0);
  const priceOut = Number(profile?.priceOut || 0);
  if (!priceIn && !priceOut) return profile?.free ? 0 : null;
  return (usage.prompt_tokens || 0) * priceIn + (usage.completion_tokens || 0) * priceOut;
}

// ---- Cancelamento de UM modelo só (sem derrubar a execução inteira) ----
const slotRegistries = new Map(); // conversationId -> { cancelled:Set, requests:Map(slot -> Set<AbortController>) }

export function cancelMultiModelSlot(conversationId, slot) {
  const reg = slotRegistries.get(conversationId);
  if (!reg) return false;
  const n = Number(slot);
  reg.cancelled.add(n);
  for (const request of reg.requests.get(n) || []) {
    if (!request.signal.aborted) request.abort('slot-cancel');
  }
  return true;
}

function roleOf(member) {
  return MULTI_ROLES[member.role] || MULTI_ROLES.livre;
}

function memberName(member) {
  if (member.label) return member.label;
  const profile = getModelProfile(member.id);
  return profile?.name || member.id;
}

function memberSystemPrompt(member, mode) {
  const base = member.prompt || roleOf(member).prompt;
  const shared = 'Você participa de uma execução MULTIMODELO: outros modelos de IA trabalham na mesma solicitação, cada um com a sua função. Responda em português do Brasil, direto ao ponto, sem se apresentar. Nesta etapa você não executa ferramentas: analise e escreva.';
  const byMode = {
    compare: 'A sua resposta será exibida lado a lado com as dos demais modelos para comparação. Responda ao pedido de forma completa e independente.',
    council: 'A sua resposta será entregue a um coordenador, que vai comparar todas as contribuições e consolidar a resposta final.',
    debate: 'Este é um debate em rodadas: nas próximas rodadas você verá as respostas dos outros modelos e poderá criticar e revisar a sua.',
    pipeline: 'Esta é uma execução em sequência: você recebe o que os modelos anteriores produziram e o que você escrever será entregue ao próximo.'
  };
  return `${base}\n\n${shared}\n${byMode[mode] || ''}`;
}

export async function runMultiModel({ userId, conversationId, userText, config, webSearch = false, effort, developer = null, onEvent }) {
  const provider = await getUserProvider(userId);
  const client = provider.client;
  const control = acquireConversationControl(conversationId);
  const registry = { cancelled: new Set(), requests: new Map() };
  slotRegistries.set(conversationId, registry);
  const startedAt = Date.now();
  try {
    const userMsgId = await saveMessage(userId, conversationId, 'user', userText);
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (!provider.hasKey) {
      const finalText = 'Nenhuma chave de API configurada. Vá em **Configurações → Provedor de IA** e cadastre a sua chave para usar o modo Multimodelo.';
      onEvent({ type: 'delta', content: finalText });
      const assistantMessageId = await saveMessage(userId, conversationId, 'assistant', finalText);
      onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId });
      return { text: finalText, usage, model: config.coordinator };
    }

    // MODO GRATUITO: todos os participantes precisam estar na allowlist
    // gratuita — a chave da plataforma não atende modelo pago escolhido à mão.
    if (provider.source === 'free') {
      const allowed = provider.freeModels || [];
      for (const member of config.models) if (!allowed.includes(member.id)) member.id = provider.model;
      if (!allowed.includes(config.coordinator)) config.coordinator = provider.model;
    }

    // Estado por participante (slot = índice na configuração)
    const slots = config.models.map((member, slot) => ({
      slot,
      member,
      name: memberName(member),
      role: member.role,
      roleLabel: roleOf(member).label,
      status: STATUS.waiting,
      text: '',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      costUsd: null,
      elapsedMs: 0,
      error: null,
      truncated: false
    }));

    let totalCostUsd = 0;
    let budgetExceeded = false;
    const addSlotCost = (state) => {
      const cost = usageCostUsd(state.member.id, state.usage);
      state.costUsd = cost;
      if (cost) totalCostUsd += cost;
      if (config.budgetUsd && totalCostUsd >= config.budgetUsd) budgetExceeded = true;
    };

    const setStatus = (state, status) => {
      state.status = status;
      onEvent({ type: 'mm_status', slot: state.slot, status });
    };

    onEvent({
      type: 'mm_start',
      mode: config.mode,
      models: slots.map(s => ({ slot: s.slot, id: s.member.id, name: s.name, role: s.role, roleLabel: s.roleLabel }))
    });

    // Capacidade mínima: o modelo precisa conversar por texto. Modelos sem
    // texto são marcados com erro e ficam de fora (sem derrubar os demais).
    for (const state of slots) {
      const profile = getModelProfile(state.member.id);
      if (profile?.capabilities?.text === false) {
        state.error = 'Este modelo não está catalogado para conversa em texto.';
        setStatus(state, STATUS.error);
      }
    }

    // ---- Contexto compartilhado (o orquestrador decide o que cada um recebe) ----
    const historyText = await buildHistoryText(conversationId, config.context);
    const baseUserContent = historyText
      ? `Contexto da conversa até aqui:\n${historyText}\n\nNOVA mensagem do usuário:\n${userText}`
      : userText;

    // ---- Chamada streaming de um participante ----
    async function streamSlot(state, msgs, { statusWhileStreaming = STATUS.answering } = {}) {
      if (registry.cancelled.has(state.slot)) { setStatus(state, STATUS.stopped); return { cancelled: true }; }
      if (state.status === STATUS.error) return { skipped: true };
      const t0 = Date.now();
      setStatus(state, STATUS.thinking);
      const requestParams = {
        model: state.member.id,
        messages: msgs,
        temperature: 0.3,
        ...openRouterRouting(),
        stream: true,
        stream_options: { include_usage: true },
        ...(config.maxTokensPerModel ? { max_tokens: config.maxTokensPerModel } : {})
      };
      let text = '';
      for (let attempt = 0; ; attempt++) {
        let segment = '';
        let activeRequest;
        try {
          activeRequest = beginProviderRequest(control);
          if (!registry.requests.has(state.slot)) registry.requests.set(state.slot, new Set());
          registry.requests.get(state.slot).add(activeRequest);
          const stream = await client.chat.completions.create(requestParams, { signal: activeRequest.signal, timeout: PROVIDER_CONNECT_TIMEOUT_MS });
          let finish = null;
          for await (const chunk of guardStreamStall(stream, { onStall: () => activeRequest.abort('stall') })) {
            if (control.stopped) { setStatus(state, STATUS.stopped); return { stopped: true, text }; }
            if (chunk.usage) { addUsage(state.usage, chunk.usage); addUsage(usage, chunk.usage); }
            if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
            const d = chunk.choices?.[0]?.delta?.content || '';
            if (d) {
              if (state.status !== statusWhileStreaming) setStatus(state, statusWhileStreaming);
              segment += d; text += d;
              onEvent({ type: 'mm_delta', slot: state.slot, content: d });
            }
          }
          state.elapsedMs += Date.now() - t0;
          state.truncated = String(finish || '').toLowerCase() === 'length';
          state.text = text;
          addSlotCost(state);
          setStatus(state, STATUS.done);
          return { text };
        } catch (err) {
          if (registry.cancelled.has(state.slot)) {
            state.elapsedMs += Date.now() - t0;
            state.text = text;
            addSlotCost(state);
            setStatus(state, STATUS.stopped);
            return { cancelled: true, text };
          }
          const interrupted = controlInterruptReason(control, activeRequest);
          if (interrupted === 'stop') { setStatus(state, STATUS.stopped); return { stopped: true, text }; }
          if (interrupted === 'pause') {
            if (segment) {
              msgs.push({ role: 'assistant', content: segment });
              msgs.push({ role: 'system', content: STREAM_PAUSE_RESUME_NOTE });
            }
            if (await gate(control, onEvent)) { setStatus(state, STATUS.stopped); return { stopped: true, text }; }
            attempt -= 1;
            continue;
          }
          if (!isRetryableStreamError(err) || attempt >= STREAM_RECOVERY_LIMIT) {
            state.elapsedMs += Date.now() - t0;
            state.text = text;
            state.error = friendlyApiError(err);
            addSlotCost(state);
            setStatus(state, STATUS.error);
            return { error: err, text };
          }
          if (segment) {
            msgs.push({ role: 'assistant', content: segment });
            msgs.push({ role: 'system', content: STREAM_RESUME_NOTE });
          }
          await retryDelay(attempt + 1);
        } finally {
          releaseProviderRequest(control, activeRequest);
          registry.requests.get(state.slot)?.delete(activeRequest);
        }
      }
    }

    function slotMessages(state, extraUserContent = null) {
      const msgs = [{ role: 'system', content: memberSystemPrompt(state.member, config.mode) }];
      const prefixEnd = msgs.length;
      msgs.push({ role: 'user', content: extraUserContent ? `${baseUserContent}\n\n${extraUserContent}` : baseUserContent });
      applyPromptCache(msgs, state.member.id, prefixEnd);
      return msgs;
    }

    const runnable = () => slots.filter(s => s.status !== STATUS.error && !registry.cancelled.has(s.slot));

    // Coordenador: resposta final consolidada, transmitida como texto principal.
    async function streamCoordinator(taskPrompt) {
      let text = '';
      const msgs = [
        { role: 'system', content: 'Você é o COORDENADOR de uma execução multimodelo: vários modelos de IA analisaram a mesma solicitação. Compare as respostas, identifique concordâncias, aponte divergências, descarte erros ou afirmações sem fundamento, aproveite os melhores argumentos e produza UMA resposta final consolidada, em português do Brasil, direta e bem organizada. Não descreva o processo — entregue a resposta.' },
        { role: 'user', content: taskPrompt }
      ];
      applyPromptCache(msgs, config.coordinator, 1);
      for (let attempt = 0; ; attempt++) {
        let segment = '';
        let activeRequest;
        try {
          activeRequest = beginProviderRequest(control);
          const stream = await client.chat.completions.create({ model: config.coordinator, messages: msgs, temperature: 0.3, ...openRouterRouting(), stream: true, stream_options: { include_usage: true } }, { signal: activeRequest.signal, timeout: PROVIDER_CONNECT_TIMEOUT_MS });
          for await (const chunk of guardStreamStall(stream, { onStall: () => activeRequest.abort('stall') })) {
            if (control.stopped) return text;
            if (chunk.usage) addUsage(usage, chunk.usage);
            const d = chunk.choices?.[0]?.delta?.content || '';
            if (d) { segment += d; text += d; onEvent({ type: 'delta', content: d }); }
          }
          return text;
        } catch (err) {
          const interrupted = controlInterruptReason(control, activeRequest);
          if (interrupted === 'stop') return text;
          if (interrupted === 'pause') {
            if (segment) {
              msgs.push({ role: 'assistant', content: segment });
              msgs.push({ role: 'system', content: STREAM_PAUSE_RESUME_NOTE });
            }
            if (await gate(control, onEvent)) return text;
            attempt -= 1;
            continue;
          }
          if (!isRetryableStreamError(err) || attempt >= STREAM_RECOVERY_LIMIT) throw err;
          if (segment) {
            msgs.push({ role: 'assistant', content: segment });
            msgs.push({ role: 'system', content: STREAM_RESUME_NOTE });
          }
          await retryDelay(attempt + 1);
        } finally {
          releaseProviderRequest(control, activeRequest);
        }
      }
    }

    const sectionFor = (state) => {
      const flags = [];
      if (state.truncated) flags.push('resposta truncada pelo limite de tokens');
      if (state.status === STATUS.stopped) flags.push('interrompido');
      if (state.error) flags.push(`erro: ${state.error}`);
      const note = flags.length ? `\n\n_[${flags.join(' · ')}]_` : '';
      return `### ${state.name} — ${state.roleLabel}\n${state.text || '_Sem resposta._'}${note}`;
    };
    const contributions = () => runnable()
      .filter(s => s.text)
      .map(s => `### ${s.name} (função: ${s.roleLabel})\n${clipForBriefing(s.text, 12000)}`)
      .join('\n\n');

    let finalText = '';
    let roundsRun = 1;

    if (config.mode === 'pipeline') {
      // ---- Execução SEQUENCIAL (especialistas em cadeia) ----
      const result = await runPipeline();
      if (result?.delegated) return result.value; // Modo Desenvolvedor: runAgent já persistiu
      finalText = result.text;
    } else {
      // ---- Fase paralela: todos respondem à mesma solicitação ----
      onEvent({ type: 'status', content: `Consultando ${runnable().length} modelo(s) em paralelo...` });
      await Promise.all(runnable().map(state => streamSlot(state, slotMessages(state))));

      if (config.mode === 'debate' && !control.stopped && !budgetExceeded) {
        // ---- Rodadas de debate: cada modelo lê os demais, critica e revisa ----
        for (let round = 2; round <= config.rounds; round++) {
          if (control.stopped || budgetExceeded) break;
          if (await gate(control, onEvent)) break;
          roundsRun = round;
          onEvent({ type: 'mm_round', round, total: config.rounds });
          onEvent({ type: 'status', content: `Debate — rodada ${round} de ${config.rounds}...` });
          const snapshot = new Map(runnable().map(s => [s.slot, s.text]));
          await Promise.all(runnable().map(state => {
            const others = runnable()
              .filter(s => s.slot !== state.slot && snapshot.get(s.slot))
              .map(s => `### ${s.name} (função: ${s.roleLabel})\n${clipForBriefing(snapshot.get(s.slot), 8000)}`)
              .join('\n\n');
            const extra = `Respostas dos OUTROS modelos na rodada anterior:\n${others || '_nenhuma resposta disponível_'}\n\nSua resposta anterior:\n${clipForBriefing(snapshot.get(state.slot) || '_nenhuma_', 8000)}\n\nRodada ${round} do debate: aponte erros ou riscos nas respostas dos outros modelos e REESCREVA a sua resposta completa incorporando o que fizer sentido. Entregue apenas a versão revisada.`;
            state.text = '';
            onEvent({ type: 'mm_reset', slot: state.slot, round });
            return streamSlot(state, slotMessages(state, extra), { statusWhileStreaming: STATUS.reviewing });
          }));
        }
      }

      if (control.stopped || await gate(control, onEvent)) {
        finalText = contributions() || '_Processamento interrompido pelo usuário._';
      } else if (config.mode === 'compare') {
        finalText = slots.map(sectionFor).join('\n\n');
      } else {
        // council e debate terminam no coordenador
        onEvent({ type: 'status', content: 'Coordenador consolidando a resposta final...' });
        const body = contributions();
        const budgetNote = budgetExceeded ? '\n\nATENÇÃO: o orçamento definido pelo usuário foi atingido — parte das rodadas pode não ter acontecido. Deixe isso claro em uma nota curta ao final.' : '';
        try {
          finalText = await streamCoordinator(`${historyText ? `Contexto da conversa:\n${clipForBriefing(historyText, 6000)}\n\n` : ''}Solicitação do usuário:\n${userText}\n\nRespostas dos modelos:\n${body || '_nenhum modelo conseguiu responder_'}${budgetNote}`);
        } catch (err) {
          finalText = `Não foi possível consolidar a resposta final: ${friendlyApiError(err)}`;
          onEvent({ type: 'delta', content: finalText });
        }
      }
    }

    // ---- Pipeline (definida aqui para reutilizar streamSlot/slotMessages) ----
    async function runPipeline() {
      // No Modo Desenvolvedor, a PRIMEIRA etapa com função implementador/código
      // executa de verdade (runAgent, com ferramentas); as etapas seguintes
      // revisam o que foi feito.
      const executorSlot = developer
        ? slots.findIndex(s => ['implementador', 'codigo'].includes(s.role))
        : -1;
      const previousOutputs = [];
      const postExecutorOutputs = [];
      let executorResult = null;
      for (const state of slots) {
        if (control.stopped || await gate(control, onEvent)) break;
        if (budgetExceeded) { setStatus(state, STATUS.stopped); continue; }
        if (state.status === STATUS.error || registry.cancelled.has(state.slot)) continue;
        const prior = previousOutputs.length
          ? `O que as etapas anteriores produziram:\n\n${previousOutputs.map(p => `### ${p.name} (função: ${p.roleLabel})\n${clipForBriefing(p.text, 10000)}`).join('\n\n')}`
          : null;
        onEvent({ type: 'status', content: `Etapa ${state.slot + 1} de ${slots.length}: ${state.name} (${state.roleLabel})...` });
        if (state.slot === executorSlot) {
          // Modo Desenvolvedor: a etapa implementadora EXECUTA de verdade, com
          // ferramentas e sandbox, via runAgent — que também persiste a resposta.
          setStatus(state, STATUS.answering);
          const t0 = Date.now();
          const briefing = prior ? clipForBriefing(prior, 20000) : null;
          executorResult = await runAgent({
            userId, conversationId, userText,
            model: state.member.id,
            assistant: null,
            webSearch, effort, developer, onEvent,
            saveUserMessage: false,
            existingUserMessageId: userMsgId,
            executionBriefing: briefing,
            forceExecution: true,
            control
          });
          addUsage(usage, executorResult.usage);
          addUsage(state.usage, executorResult.usage);
          state.text = clipForBriefing(String(executorResult.text || ''), META_TEXT_LIMIT);
          state.elapsedMs = Date.now() - t0;
          addSlotCost(state);
          setStatus(state, executorResult.stopped ? STATUS.stopped : STATUS.done);
          previousOutputs.push({ name: state.name, roleLabel: state.roleLabel, text: state.text });
          if (executorResult.stopped) break;
          continue;
        }
        const extra = prior ? `${prior}\n\nAgora execute a SUA função (${state.roleLabel}) sobre esse material e o pedido original.` : null;
        await streamSlot(state, slotMessages(state, extra));
        if (state.text) {
          const output = { name: state.name, roleLabel: state.roleLabel, text: state.text };
          previousOutputs.push(output);
          if (executorResult) postExecutorOutputs.push(output);
        }
      }
      if (executorResult) {
        // A execução real já foi salva pelo runAgent. Se houve etapas de revisão
        // DEPOIS do implementador, salvamos um segundo balão com os pareceres.
        if (postExecutorOutputs.length) {
          const reviewText = `## Revisão da equipe de modelos\n\n${postExecutorOutputs.map(p => `### ${p.name} — ${p.roleLabel}\n${p.text}`).join('\n\n')}`;
          const multiMeta = buildMeta();
          const reviewMsgId = await saveMessage(userId, conversationId, 'assistant', reviewText, { multiMeta });
          onEvent({ type: 'mm_review_saved', assistantMessageId: reviewMsgId });
        }
        // Fecha o quadro ao vivo mesmo sem mensagem própria do multimodelo
        // (a execução real foi persistida pelo runAgent).
        onEvent({ type: 'mm_done', meta: buildMeta() });
        return { delegated: true, value: { ...executorResult, usage } };
      }
      const last = [...slots].reverse().find(s => s.text);
      const text = last
        ? `${slots.length > 1 ? `_Execução sequencial: ${slots.map(s => s.name).join(' → ')}_\n\n` : ''}${last.text}`
        : '_Nenhuma etapa da sequência produziu resposta._';
      return { text };
    }

    function buildMeta() {
      return {
        mode: config.mode,
        context: config.context,
        rounds: config.mode === 'debate' ? roundsRun : undefined,
        budgetUsd: config.budgetUsd || undefined,
        budgetExceeded: budgetExceeded || undefined,
        elapsedMs: Date.now() - startedAt,
        models: slots.map(s => ({
          slot: s.slot, id: s.member.id, name: s.name, role: s.role, roleLabel: s.roleLabel,
          status: s.status, text: clipForBriefing(s.text, META_TEXT_LIMIT),
          usage: s.usage, costUsd: s.costUsd, elapsedMs: s.elapsedMs,
          error: s.error, truncated: s.truncated || undefined
        })),
        totals: { costUsd: totalCostUsd || null, tokens: usage.total_tokens }
      };
    }

    if (control.stopped && !finalText.trim()) finalText = '_Processamento interrompido pelo usuário._';
    if (!finalText.trim()) finalText = 'Concluído.';
    if (budgetExceeded && config.mode !== 'compare') {
      finalText += `\n\n_⚠ Orçamento de US$ ${config.budgetUsd.toFixed(2)} atingido — a execução foi encerrada antes de todas as etapas._`;
    }

    const multiMeta = buildMeta();
    onEvent({ type: 'mm_done', meta: multiMeta });
    const doneMsgId = await saveMessage(userId, conversationId, 'assistant', finalText, { multiMeta });
    onEvent({ type: 'saved', userMessageId: userMsgId, assistantMessageId: doneMsgId });
    indexAfterReply(userId, conversationId).catch(() => {});
    return { text: finalText, usage, model: config.coordinator, stopped: control.stopped };
  } finally {
    slotRegistries.delete(conversationId);
    releaseConversationControl(conversationId, control);
  }
}

// Contexto que os modelos recebem — o usuário escolhe quanto do histórico vai
// junto (custo x continuidade). O padrão é 'recent'.
async function buildHistoryText(conversationId, policy) {
  if (policy === 'none') return '';
  if (policy === 'summary') {
    try {
      const conv = await db.prepare('SELECT summary_long, summary_short FROM conversations WHERE id=?').get(conversationId);
      const summary = conv?.summary_long || conv?.summary_short;
      if (summary) return `Resumo da conversa até aqui:\n${String(summary).slice(0, 6000)}`;
    } catch {}
    // sem resumo salvo ainda: cai para o recorte recente
    policy = 'recent';
  }
  const limit = policy === 'full' ? 30 : 8;
  const chars = policy === 'full' ? 2000 : 1200;
  let rows = [];
  try {
    rows = (await db.prepare(`
      SELECT role, content FROM (
        SELECT role, content, created_at, seq FROM messages
        WHERE conversation_id=? ORDER BY created_at DESC, seq DESC LIMIT ?
      ) sub ORDER BY created_at ASC, seq ASC`).all(conversationId, limit)).slice(0, -1);
  } catch {}
  return rows.map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${String(m.content).slice(0, chars)}`).join('\n');
}
