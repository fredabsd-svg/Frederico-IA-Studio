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

export function normalizeProviderType(value) {
  const key = String(value || '').trim().toLowerCase();
  return Object.hasOwn(PROVIDER_PRESETS, key) ? key : 'custom';
}

export function normalizeBaseURL(value, providerType = 'custom') {
  const preset = PROVIDER_PRESETS[normalizeProviderType(providerType)];
  const raw = String(value || preset.baseURL || '').trim().replace(/\/+$/, '');
  if (!raw || raw.length > 500) throw new Error('Informe uma URL base válida para o provedor.');
  let url;
  try { url = new URL(raw); } catch { throw new Error('A URL base do provedor é inválida.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('A URL base deve usar HTTP/HTTPS e não pode conter credenciais, parâmetros ou fragmentos.');
  }
  return raw;
}

function normalizedCatalog(data) {
  const source = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const seen = new Set();
  return source.map(item => typeof item === 'string' ? { id: item } : item)
    .filter(item => item && typeof item === 'object')
    .map(item => ({ ...item, id: String(item.id || '').trim() }))
    .filter(item => item.id && item.id.length <= 300 && !seen.has(item.id) && seen.add(item.id));
}

async function responseError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || body?.error || '';
  } catch {}
  if (response.status === 401 || response.status === 403) return 'A chave foi recusada pelo provedor.';
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
    if (!response.ok) throw new Error(await responseError(response));
    const models = normalizedCatalog(await response.json());
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
      ? 'A chave foi recusada pelo provedor.'
      : (error?.message || listFailure?.message || 'Não foi possível validar a chave.');
    throw new Error(String(message).slice(0, 300));
  }
}
