// Cliente do provedor de modelos: cliente legado de nível de módulo, retomada
// de stream interrompido, roteamento OpenRouter, acumulação de usage e
// tradução de erros da API em mensagens amigáveis.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import OpenAI from 'openai';
import { isUnsupportedToolError } from '../modelCapabilities.js';

const modelApiBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
// Cliente "legado" de nível de módulo. No BYOK ele é SEMPRE sombreado pelo
// provider.client do usuário (getUserProvider). O fallback 'sem-chave' evita
// que o construtor da OpenAI derrube o boot quando o servidor não tem chave
// própria (caso da SaaS pura, com ALLOW_SHARED_KEY=false) — igual ao indexer.
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'sem-chave',
  baseURL: modelApiBaseUrl
});

export const STREAM_RECOVERY_LIMIT = Math.max(0, Number(process.env.MODEL_STREAM_RECOVERY_LIMIT || 2));
export const STREAM_RESUME_NOTE = 'A resposta anterior do provedor foi interrompida temporariamente. Continue exatamente do ponto em que parou, sem repetir texto nem desfazer as ferramentas ja executadas. Conclua a tarefa.';
export const STREAM_PAUSE_RESUME_NOTE = 'A resposta anterior foi pausada pelo usuário. Continue exatamente do ponto em que parou, sem repetir texto e sem desfazer ferramentas já executadas.';
export const PROVIDER_TIMEOUT_NOTICE = '\n\n_Nota: o provedor do modelo ficou indisponivel enquanto esta etapa era gerada. O aplicativo tentou retomar automaticamente, mas nao recebeu uma resposta completa. Reenvie esta mesma tarefa para continuar a partir do trabalho ja salvo._';

export function isRetryableStreamError(error) {
  const status = Number(error?.status ?? error?.code ?? error?.error?.code);
  const detail = [error?.message, error?.error?.message, error?.error?.metadata?.error_type]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return [408, 429, 500, 502, 503, 504].includes(status)
    || /upstream idle timeout|gateway timeout|temporar(?:y|ily)|provider.*(?:overload|timeout)|econnreset|fetch failed/.test(detail);
}

export function openRouterRouting(hasTools = false) {
  if (!/openrouter\.ai/i.test(modelApiBaseUrl)) return {};
  const provider = {};
  const configuredSort = String(process.env.OPENROUTER_PROVIDER_SORT || '').trim();
  if (configuredSort) provider.sort = configuredSort;
  if (hasTools) provider.require_parameters = true;
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

export function providerSupportsPromptCache(model) {
  if (!PROMPT_CACHE_ENABLED) return false;
  if (!/openrouter\.ai/i.test(modelApiBaseUrl)) return false;
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
export function applyPromptCache(messages, model, staticPrefixEnd = 0) {
  if (!Array.isArray(messages) || !providerSupportsPromptCache(model)) return messages;
  if (messages[0]?.role === 'system') markMessageCached(messages[0]);
  const end = Math.min(staticPrefixEnd, messages.length) - 1;
  if (end > 0 && messages[end]?.role === 'system') markMessageCached(messages[end]);
  return messages;
}

// Traduz erros comuns da API do provedor em mensagens claras em português
export function friendlyApiError(err) {
  const status = err?.status || err?.response?.status;
  const raw = String(err?.message || '');
  if (err?.code === 'CONVERSATION_BUSY') return 'Esta conversa já está processando uma resposta. Aguarde terminar ou pare o processamento antes de enviar outra mensagem.';
  if (status === 401) return 'Chave da API inválida ou expirada. Confira sua chave em Configurações → Provedor de IA.';
  if (status === 402) return 'Sem créditos no provedor (OpenRouter/DeepSeek). Adicione créditos na sua conta e tente de novo.';
  if (status === 429) return 'Limite de uso atingido (erro 429). Modelos GRATUITOS têm cota pequena e fila compartilhada — aguarde alguns minutos ou, melhor, escolha um modelo pago (ex.: DeepSeek Chat, que custa centavos).';
  // O provedor também responde 404 quando o modelo EXISTE mas não aceita
  // ferramentas ("No endpoints found that support tool use"). Sem ferramentas o
  // app não executa código nem gera arquivos — avisar isso evita a confusão de
  // dizer "modelo não encontrado" para um modelo que está lá e funciona.
  if (isUnsupportedToolError(err)) {
    return 'Este modelo não oferece ferramentas neste ambiente. Ele ainda pode conversar por texto; para criar arquivos, pesquisar ou executar algo, escolha no seletor um modelo marcado com Ferramentas.';
  }
  if (status === 404) return 'Modelo não encontrado no provedor. Escolha outro modelo no seletor.';
  if (status >= 500) return 'O provedor do modelo está instável neste momento. Tente novamente em instantes.';
  return raw.slice(0, 300) || 'Erro inesperado ao falar com o modelo.';
}
