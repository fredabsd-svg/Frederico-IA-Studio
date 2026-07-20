// Cliente do provedor de modelos: cliente legado de nível de módulo, retomada
// de stream interrompido, roteamento OpenRouter, acumulação de usage e
// tradução de erros da API em mensagens amigáveis.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import { createAiClient } from '../aiClient.js';
import { isUnsupportedToolError } from '../modelCapabilities.js';

const modelApiBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
// Cliente "legado" de nível de módulo. No BYOK ele é SEMPRE sombreado pelo
// provider.client do usuário (getUserProvider). O fallback 'sem-chave' evita
// que o construtor da OpenAI derrube o boot quando o servidor não tem chave
// própria (caso da SaaS pura, com ALLOW_SHARED_KEY=false) — igual ao indexer.
const client = createAiClient({
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
