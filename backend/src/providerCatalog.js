import { createAiClient } from './aiClient.js';

export const PROVIDER_PRESETS = Object.freeze({
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' },
  nvidia: { name: 'NVIDIA', baseURL: 'https://integrate.api.nvidia.com/v1' },
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com' },
  alibaba: { name: 'Alibaba Model Studio', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  groq: { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1' },
  gemini: { name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  mistral: { name: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1' },
  custom: { name: 'OpenAI compatível', baseURL: '' }
});

// GET /models da DeepSeek autentica a chave e lista os IDs disponíveis, mas
// não publica nome amigável, contexto, capacidades ou preços. Esses metadados
// vêm da documentação oficial vigente em 2026-07-22:
// https://api-docs.deepseek.com/quick_start/pricing/
// Os preços abaixo são convertidos de USD por 1M tokens para USD por token,
// que é a unidade interna também usada pelos catálogos da OpenRouter.
const DEEPSEEK_MODEL_METADATA = Object.freeze({
  'deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    context_length: 1_000_000,
    pricing: { prompt: 0.14 / 1_000_000, completion: 0.28 / 1_000_000, cache_read: 0.0028 / 1_000_000 },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'tool_choice', 'reasoning_effort', 'response_format']
  },
  'deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    context_length: 1_000_000,
    pricing: { prompt: 0.435 / 1_000_000, completion: 0.87 / 1_000_000, cache_read: 0.003625 / 1_000_000 },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'tool_choice', 'reasoning_effort', 'response_format']
  }
});

export function normalizeProviderType(value) {
  const key = String(value || '').trim().toLowerCase();
  return Object.hasOwn(PROVIDER_PRESETS, key) ? key : 'custom';
}

export function normalizeBaseURL(value, providerType = 'custom') {
  const type = normalizeProviderType(providerType);
  const preset = PROVIDER_PRESETS[type];
  const raw = String(value || preset.baseURL || '').trim().replace(/\/+$/, '');
  if (!raw || raw.length > 500) throw new Error('Informe uma URL base válida para o provedor.');
  let url;
  try { url = new URL(raw); } catch { throw new Error('A URL base do provedor é inválida.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('A URL base deve usar HTTP/HTTPS e não pode conter credenciais, parâmetros ou fragmentos.');
  }
  if (type === 'alibaba') {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    const officialHost = /^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(host)
      || host.endsWith('.dashscope.aliyuncs.com')
      || host.endsWith('.maas.aliyuncs.com');
    if (url.protocol !== 'https:' || !officialHost || !['/compatible-mode/v1', '/v1'].includes(path)) {
      throw new Error('Use o endpoint OpenAI compatível oficial do Alibaba, no mesmo workspace e região da chave.');
    }
  }
  return raw;
}

function enrichProviderModel(model, providerType) {
  if (providerType !== 'deepseek') return model;
  const metadata = DEEPSEEK_MODEL_METADATA[model.id];
  if (!metadata) return model;
  return {
    ...metadata,
    ...model,
    name: String(model.name || '').trim() || metadata.name,
    context_length: Number(model.context_length || model.context || 0) || metadata.context_length,
    pricing: { ...metadata.pricing, ...(model.pricing || {}) },
    supported_parameters: Array.isArray(model.supported_parameters) && model.supported_parameters.length
      ? model.supported_parameters
      : metadata.supported_parameters
  };
}

function normalizedCatalog(data, providerType = 'custom') {
  const source = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const seen = new Set();
  return source.map(item => typeof item === 'string' ? { id: item } : item)
    .filter(item => item && typeof item === 'object')
    .map(item => ({ ...item, id: String(item.id || '').trim() }))
    .filter(item => item.id && item.id.length <= 300 && !seen.has(item.id) && seen.add(item.id))
    .map(item => enrichProviderModel(item, providerType));
}

// Também corrige catálogos já armazenados antes deste enriquecimento, para que
// a atualização do servidor resolva a interface sem exigir que a pessoa apague
// e cadastre novamente a chave.
export function enrichProviderCatalog(models, providerType = 'custom') {
  return normalizedCatalog(models, normalizeProviderType(providerType));
}

async function responseError(response, providerType = 'custom') {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || body?.error || '';
  } catch {}
  if (response.status === 401 || response.status === 403) {
    if (providerType === 'alibaba') return 'A chave foi recusada. Confirme que a URL base é o campo openAiCompatible do mesmo CSV, workspace e região.';
    return 'A chave foi recusada pelo provedor.';
  }
  return String(detail || `O provedor respondeu com HTTP ${response.status}.`).slice(0, 300);
}

export async function importProviderCatalog({ apiKey, baseURL, providerType = 'custom', modelHint = '', fetchImpl = fetch, clientFactory = createAiClient, timeoutMs = 15000 } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Informe a chave de API.');
  const type = normalizeProviderType(providerType);
  const base = normalizeBaseURL(baseURL, type);
  let listFailure = null;
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(await responseError(response, type));
    const models = normalizedCatalog(await response.json(), type);
    if (models.length) return { baseURL: base, models, validation: 'catalog' };
    listFailure = new Error('O provedor não retornou nenhum modelo para esta chave.');
  } catch (error) {
    listFailure = error;
  }

  // Alguns endpoints OpenAI-compatíveis não implementam GET /models. Nesses
  // casos só aceitamos um modelo explicitamente informado e comprovamos a
  // credencial com uma chamada mínima; não inventamos um catálogo genérico.
  const hinted = String(modelHint || '').trim();
  if (!hinted) throw listFailure;
  try {
    const client = clientFactory({ apiKey: key, baseURL: base });
    await client.chat.completions.create({
      model: hinted,
      messages: [{ role: 'user', content: 'Responda apenas OK.' }],
      max_tokens: 2,
      stream: false
    }, { timeout: timeoutMs });
    return { baseURL: base, models: [{ id: hinted, name: hinted }], validation: 'model' };
  } catch (error) {
    const message = error?.status === 401 || error?.status === 403
      ? (type === 'alibaba'
          ? 'A chave foi recusada. Confirme que a URL base é o campo openAiCompatible do mesmo CSV, workspace e região.'
          : 'A chave foi recusada pelo provedor.')
      : (error?.message || listFailure?.message || 'Não foi possível validar a chave.');
    throw new Error(String(message).slice(0, 300));
  }
}
