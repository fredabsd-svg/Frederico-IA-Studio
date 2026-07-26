// Cliente do provedor de modelos: cliente legado de nível de módulo, retomada
// de stream interrompido, roteamento OpenRouter, acumulação de usage e
// tradução de erros da API em mensagens amigáveis.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import { isUnsupportedToolError } from '../modelCapabilities.js';

const modelApiBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export const STREAM_RECOVERY_LIMIT = Math.max(0, Number(process.env.MODEL_STREAM_RECOVERY_LIMIT || 2));
export const STREAM_RESUME_NOTE = 'A resposta anterior do provedor foi interrompida temporariamente. Continue exatamente do ponto em que parou, sem repetir texto nem desfazer as ferramentas ja executadas. Conclua a tarefa.';
export const STREAM_PAUSE_RESUME_NOTE = 'A resposta anterior foi pausada pelo usuário. Continue exatamente do ponto em que parou, sem repetir texto e sem desfazer ferramentas já executadas.';
export const PROVIDER_TIMEOUT_NOTICE = '\n\n_Nota: o provedor do modelo ficou indisponivel enquanto esta etapa era gerada. O aplicativo tentou retomar automaticamente, mas nao recebeu uma resposta completa. Reenvie esta mesma tarefa para continuar a partir do trabalho ja salvo._';

export function isRetryableStreamError(error) {
  // Watchdog de stream parado (streamGuard.js): o provedor deixou de mandar
  // dados sem fechar a conexão. É retryável por definição — o objetivo do
  // watchdog é justamente acionar esta recuperação em vez de travar p/ sempre.
  if (error?.code === 'STREAM_STALLED') return true;
  const status = Number(error?.status ?? error?.code ?? error?.error?.code);
  const detail = [error?.message, error?.error?.message, error?.error?.metadata?.error_type]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return [408, 429, 500, 502, 503, 504].includes(status)
    || /upstream idle timeout|gateway timeout|temporar(?:y|ily)|provider.*(?:overload|timeout)|econnreset|fetch failed|stream stalled|request timed out/.test(detail);
}

// ---- Qualidade x resiliência do roteamento OpenRouter ----
// O OpenRouter balanceia cada requisição entre vários provedores do MESMO
// modelo, e esses provedores rodam o modelo em precisões diferentes
// (quantização). As faixas mais agressivas — int4/int8/fp4/fp6 — comprimem os
// pesos ao ponto de a QUALIDADE cair de forma perceptível; fp8 e acima
// (fp16/bf16/fp32) preservam a qualidade. Como o app é agêntico (usa
// ferramentas em vários passos), cair num provedor de baixa precisão a cada
// requisição deixa a qualidade oscilando de forma invisível — que foi
// exatamente a queixa que originou esta mudança.
//
// MEIO-TERMO (não travar num único provedor, mas manter a qualidade):
//   1) allow_fallbacks: true  -> mantém a resiliência: se o provedor preferido
//      cair, o OpenRouter reroteia para OUTRO provedor QUE AINDA ATENDA o filtro
//      de qualidade abaixo (em vez de falhar a requisição inteira).
//   2) quantizations          -> allowlist de precisões aceitáveis. O padrão
//      exclui só a compressão agressiva (int4/int8/fp4/fp6) e mantém fp8+ e
//      'unknown'. Verificado contra os modelos reais em uso: DeepSeek V3 só tem
//      provedores fp8/unknown/fp4 (nenhum fp16), e modelos como gpt-4o só têm
//      'unknown' — por isso 'unknown' PRECISA ficar na lista, senão modelos
//      inteiros ficariam sem endpoint. Assim removemos o risco real (fp4) sem
//      quebrar nada nem prender a um provedor só.
//
// Tudo é ajustável por ambiente, sem tocar no código:
//   OPENROUTER_QUANTIZATIONS = lista separada por vírgula (ex.: "bf16,fp16,fp32"
//     para exigir precisão cheia onde existir) ou "off"/"any" para desligar o
//     filtro e voltar ao comportamento antigo (qualquer provedor).
//   OPENROUTER_ALLOW_FALLBACKS = "0" para travar no provedor preferido (falha
//     em vez de trocar de provedor); qualquer outro valor mantém o fallback.
const DEFAULT_QUANTIZATIONS = ['fp8', 'fp16', 'bf16', 'fp32', 'unknown'];

function resolveQuantizations() {
  const raw = process.env.OPENROUTER_QUANTIZATIONS;
  if (raw === undefined) return DEFAULT_QUANTIZATIONS;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'off' || trimmed === 'any' || trimmed === 'all') return [];
  return raw.split(',').map(value => value.trim()).filter(Boolean);
}

export function openRouterRouting(hasTools = false, baseURL = modelApiBaseUrl) {
  if (!/openrouter\.ai/i.test(String(baseURL || ''))) return {};
  const provider = {};
  const configuredSort = String(process.env.OPENROUTER_PROVIDER_SORT || '').trim();
  if (configuredSort) provider.sort = configuredSort;
  if (hasTools) provider.require_parameters = true;

  // Resiliência: reroteia entre provedores da faixa de qualidade permitida.
  provider.allow_fallbacks = process.env.OPENROUTER_ALLOW_FALLBACKS !== '0';

  // Qualidade: evita provedores de compressão agressiva sem prender a um só.
  const quantizations = resolveQuantizations();
  if (quantizations.length) provider.quantizations = quantizations;

  return { provider };
}

export function retryDelay(attempt) {
  return new Promise(resolve => setTimeout(resolve, Math.min(4000, 750 * Math.max(1, attempt))));
}

export function addUsage(acc, u) {
  if (!u) return;
  acc.prompt_tokens += u.prompt_tokens || 0;
  acc.completion_tokens += u.completion_tokens || 0;
  acc.total_tokens += u.total_tokens || 0;
  // Tokens servidos pelo cache de prompt do provedor (Anthropic/DeepSeek/OpenRouter
  // expõem em `prompt_tokens_details.cached_tokens`). Contabilizar deixa medir o
  // quanto o prompt caching está economizando. `|| 0` mantém o campo opcional.
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
  acc.cached_tokens = (acc.cached_tokens || 0) + (cached || 0);
}

// ---- Prompt caching (cache_control) ----
// Reenviamos os MESMOS blocos `system` gigantes (prompt-base, contrato de
// qualidade, notas de ferramentas, memória) a cada passo do loop e a cada
// mensagem da conversa. Marcar o prefixo estável com cache_control faz o
// provedor reaproveitar esse prefixo: menos tokens de ENTRADA cobrados e menor
// latência (o modelo não reprocessa o preâmbulo).
//
// Habilitado só onde é suportado E seguro: roteando pelo OpenRouter para as
// famílias que aceitam cache_control (Anthropic/Claude e Google/Gemini). Para a
// API direta da DeepSeek o cache é AUTOMÁTICO (não precisa e não aceita
// cache_control), então NÃO tocamos nas mensagens nesse caso. Desligável com
// PROMPT_CACHE=0.
const PROMPT_CACHE_ENABLED = process.env.PROMPT_CACHE !== '0';

export function providerSupportsPromptCache(model, baseURL = modelApiBaseUrl) {
  if (!PROMPT_CACHE_ENABLED) return false;
  if (!/openrouter\.ai/i.test(String(baseURL || ''))) return false;
  return /(anthropic|claude|google|gemini)/i.test(String(model || ''));
}

// Converte o conteúdo (string) de uma mensagem num bloco único com cache_control.
// Idempotente: se já for array (já marcado, ou multimodal), não faz nada.
function markMessageCached(message) {
  if (!message || typeof message.content !== 'string' || !message.content) return false;
  message.content = [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }];
  return true;
}

// Aplica os breakpoints de cache no array de mensagens (mutação in place):
//   1) fim do prompt-base (system[0]) — idêntico em toda a conversa;
//   2) fim do preâmbulo estático (antes de memória/histórico), quando houver mais
//      de uma mensagem estável — o provedor usa o MAIOR prefixo que casar, então
//      esse 2º ponto rende nos turnos em que o preâmbulo não mudou.
// Chamar mais de uma vez é seguro (idempotente). Se o modelo não suportar, é um
// no-op — nada é adicionado.
export function applyPromptCache(messages, model, staticPrefixEnd = 0, baseURL = modelApiBaseUrl) {
  if (!Array.isArray(messages) || !providerSupportsPromptCache(model, baseURL)) return messages;
  if (messages[0]?.role === 'system') markMessageCached(messages[0]);
  const end = Math.min(staticPrefixEnd, messages.length) - 1;
  if (end > 0 && messages[end]?.role === 'system') markMessageCached(messages[end]);
  return messages;
}

// Remove somente os marcadores adicionados por applyPromptCache. É obrigatório
// antes de trocar para um modelo de reserva: um bloco cache_control aceito pelo
// Claude/Gemini pode ser rejeitado por DeepSeek, Mistral ou outro endpoint.
export function clearPromptCache(messages) {
  if (!Array.isArray(messages)) return messages;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    message.content = message.content.map(block => {
      if (!block || typeof block !== 'object' || !('cache_control' in block)) return block;
      const { cache_control, ...clean } = block;
      return clean;
    });
    if (message.content.length === 1 && message.content[0]?.type === 'text' && typeof message.content[0].text === 'string') {
      message.content = message.content[0].text;
    }
  }
  return messages;
}

// Anexa ao erro QUAL provedor e QUAL modelo falharam.
//
// Sem isto, uma conta com mais de um provedor recebia "Chave da API inválida ou
// expirada" sem dizer de quem: o usuário abria Configurações, via o provedor que
// acabara de validar com a chave OK e concluía que o app estava errado. A
// chamada que falhou era de OUTRO provedor — o modelo do assistente não tem
// prefixo `<provedor>::`, então `getUserProvider` cai no primeiro provedor
// cadastrado quando o id não é achado em catálogo nenhum.
export function tagProviderError(err, { providerName, model } = {}) {
  if (!err || typeof err !== 'object') return err;
  if (!err.providerName && providerName) err.providerName = providerName;
  if (!err.providerModel && model) err.providerModel = model;
  return err;
}

// Traduz erros comuns da API do provedor em mensagens claras em português
export function friendlyApiError(err) {
  const status = err?.status || err?.response?.status;
  const raw = String(err?.message || '');
  // "do provedor X" / "(modelo Y)" só entram quando são conhecidos — nunca
  // inventamos um nome, porque um nome errado é pior que nenhum.
  const quem = err?.providerName ? ` do provedor "${err.providerName}"` : '';
  const qual = err?.providerModel ? ` (modelo ${err.providerModel})` : '';
  if (err?.code === 'CONVERSATION_BUSY') return 'Esta conversa já está processando uma resposta. Aguarde terminar ou pare o processamento antes de enviar outra mensagem.';
  if (status === 401) return `Chave da API${quem} recusada${qual}: inválida, expirada ou sem acesso a este modelo. Se você tem mais de um provedor cadastrado, confira a chave DESSE provedor em Configurações → Provedor de IA.`;
  if (status === 402) return `Sem créditos no provedor${quem ? ` "${err.providerName}"` : ' (OpenRouter/DeepSeek)'}${qual}. Adicione créditos na sua conta e tente de novo.`;
  if (status === 429) return 'Limite de uso atingido (erro 429). Modelos GRATUITOS têm cota pequena e fila compartilhada — aguarde alguns minutos ou, melhor, escolha um modelo pago (ex.: DeepSeek Chat, que custa centavos).';
  // O provedor também responde 404 quando o modelo EXISTE mas não aceita
  // ferramentas ("No endpoints found that support tool use"). Sem ferramentas o
  // app não executa código nem gera arquivos — avisar isso evita a confusão de
  // dizer "modelo não encontrado" para um modelo que está lá e funciona.
  if (isUnsupportedToolError(err)) {
    return 'Este modelo não oferece ferramentas neste ambiente. Ele ainda pode conversar por texto; para criar arquivos, pesquisar ou executar algo, escolha no seletor um modelo marcado com Ferramentas.';
  }
  if (status === 404) {
    // Mostra o motivo real do provedor (ex.: "xyz is not a valid model id",
    // "No endpoints found for <modelo>"). Sem isso, todo 404 virava um genérico
    // "Modelo não encontrado" que escondia QUAL modelo e por quê.
    const detail = String(err?.error?.message || err?.response?.data?.error?.message || '').trim();
    return `Modelo não encontrado ou indisponível no provedor${detail ? ` (${detail.slice(0, 180)})` : ''}. Escolha outro modelo no seletor.`;
  }
  if (status >= 500) return 'O provedor do modelo está instável neste momento. Tente novamente em instantes.';
  return raw.slice(0, 300) || 'Erro inesperado ao falar com o modelo.';
}
