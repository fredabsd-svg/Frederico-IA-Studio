import dns from 'node:dns';
import net from 'node:net';
import { createAiClient } from './aiClient.js';
import { isBlockedHost } from './tools.js';
import { sanitizeUpstreamDetail } from './upstreamDetail.js';

export const PROVIDER_PRESETS = Object.freeze({
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', dashboardURL: 'https://openrouter.ai/activity', billingURL: 'https://openrouter.ai/settings/credits', balance: 'openrouter' },
  nvidia: { name: 'NVIDIA', baseURL: 'https://integrate.api.nvidia.com/v1', dashboardURL: 'https://build.nvidia.com/settings/api-keys', billingURL: 'https://build.nvidia.com/settings/api-keys' },
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com', dashboardURL: 'https://platform.deepseek.com/usage', billingURL: 'https://platform.deepseek.com/top_up', balance: 'deepseek' },
  alibaba: { name: 'Alibaba Model Studio', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', dashboardURL: 'https://modelstudio.console.alibabacloud.com/', billingURL: 'https://billing-cost.console.aliyun.com/' },
  groq: { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', dashboardURL: 'https://console.groq.com/dashboard/usage', billingURL: 'https://console.groq.com/settings/billing' },
  gemini: { name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', dashboardURL: 'https://aistudio.google.com/usage', billingURL: 'https://console.cloud.google.com/billing' },
  mistral: { name: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1', dashboardURL: 'https://console.mistral.ai/usage/', billingURL: 'https://console.mistral.ai/billing/' },
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

export function providerPublicMetadata(providerType) {
  const preset = PROVIDER_PRESETS[normalizeProviderType(providerType)];
  return {
    dashboardURL: preset.dashboardURL || '',
    billingURL: preset.billingURL || '',
    officialBalanceSupported: Boolean(preset.balance)
  };
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

// ---- Guarda de SSRF da URL base do provedor ---------------------------------
// A URL base de um provedor "OpenAI compatível" é digitada pelo usuário, e o
// BACKEND faz requisições autenticadas a ela (GET /models, saldo, e depois as
// chamadas de chat). Sem guarda, qualquer usuário apontava a URL para
// http://169.254.169.254/, http://postgres:5432, http://docling-service:8000 ou
// o docker-guard e usava o erro devolvido como oráculo da rede interna.
// Mesma política do web_fetch (tools.js → isBlockedHost): loopback, redes
// privadas, link-local, CGNAT, multicast, ULA/link-local IPv6 e nomes .local/
// .internal/localhost são recusados — e o nome é RESOLVIDO e cada IP conferido
// (anti-DNS-rebinding). Redirecionamentos não são seguidos.
//
// Endpoints LOCAIS legítimos (Ollama, LM Studio, vLLM na mesma máquina/rede)
// exigem opt-in explícito do operador: PROVIDER_ALLOW_PRIVATE_URLS=true. Mesmo
// com ele, link-local (169.254.0.0/16, fe80::/10 — metadados de nuvem) continua
// bloqueado.
export function privateProviderUrlsAllowed() {
  return String(process.env.PROVIDER_ALLOW_PRIVATE_URLS || '').trim().toLowerCase() === 'true';
}

function stripBrackets(host) {
  const h = String(host || '').trim();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function isLinkLocal(address) {
  const h = stripBrackets(address).toLowerCase();
  if (/^169\.254\./.test(h)) return true;
  if (/^::ffff:169\.254\./.test(h) || /^::ffff:a9fe:/.test(h)) return true;
  return /^fe[89ab]/.test(h);
}

const BLOCKED_PROVIDER_MSG = 'A URL base aponta para um endereço interno ou local, que não é permitido nesta instalação. Use o endereço público da API do provedor (o administrador pode liberar endpoints locais com PROVIDER_ALLOW_PRIVATE_URLS=true).';

function defaultResolve(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

// Lança quando a URL base não pode ser alcançada com segurança. `resolveImpl`
// é injetável nos testes (sem DNS de verdade).
export async function assertProviderUrlAllowed(baseURL, { resolveImpl = defaultResolve, allowPrivate = privateProviderUrlsAllowed() } = {}) {
  let url;
  try { url = new URL(baseURL); } catch { throw new Error('A URL base do provedor é inválida.'); }
  const host = stripBrackets(url.hostname);
  if (isLinkLocal(host)) throw new Error(BLOCKED_PROVIDER_MSG);
  if (!allowPrivate && isBlockedHost(host)) throw new Error(BLOCKED_PROVIDER_MSG);
  if (net.isIP(host)) return;
  let addresses;
  try { addresses = await resolveImpl(host); }
  catch { throw new Error('Não foi possível resolver o endereço da URL base do provedor.'); }
  const list = (Array.isArray(addresses) ? addresses : [addresses]).map(a => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (!list.length) throw new Error('Não foi possível resolver o endereço da URL base do provedor.');
  for (const address of list) {
    if (isLinkLocal(address)) throw new Error(BLOCKED_PROVIDER_MSG);
    if (!allowPrivate && isBlockedHost(address)) throw new Error(BLOCKED_PROVIDER_MSG);
  }
}

// Saneamento do texto de erro do provedor: mora em upstreamDetail.js (folha,
// reusada pelo agente) e continua exportado daqui para os chamadores atuais.
export { sanitizeUpstreamDetail };

function isRedirect(response) {
  return [301, 302, 303, 307, 308].includes(Number(response?.status));
}

const REDIRECT_MSG = 'O provedor respondeu com um redirecionamento. Informe a URL base FINAL da API (redirecionamentos não são seguidos por segurança).';

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

function numberOrNull(...values) {
  for (const value of values) {
    if (value === '' || value == null) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function boolOrNull(...values) {
  for (const value of values) if (value === true || value === false) return value;
  return null;
}

function canonicalModel(model, providerType) {
  const architecture = model.architecture || {};
  const capabilities = model.capabilities || {};
  const pricing = model.pricing || {};
  const input = architecture.input_modalities || model.input_modalities || model.modalities?.input;
  const output = architecture.output_modalities || model.output_modalities || model.modalities?.output;
  const prompt = numberOrNull(pricing.prompt, pricing.input, model.input_price);
  const completion = numberOrNull(pricing.completion, pricing.output, model.output_price);
  const family = String(model.family || model.owned_by || model.id || '').split('/')[0].split(':')[0];
  const normalizedCapabilities = { ...capabilities };
  const normalizedArchitecture = {
    ...architecture,
    ...(Array.isArray(input) ? { input_modalities: input.map(String) } : {}),
    ...(Array.isArray(output) ? { output_modalities: output.map(String) } : {})
  };
  for (const [key, value] of Object.entries({
    tools: boolOrNull(capabilities.tools, capabilities.function_calling),
    vision: boolOrNull(capabilities.vision),
    reasoning: boolOrNull(capabilities.reasoning),
    embeddings: boolOrNull(capabilities.embeddings, model.type === 'embedding' ? true : null)
  })) if (value != null) normalizedCapabilities[key] = value;
  return enrichProviderModel({
    ...model,
    name: String(model.name || model.display_name || '').trim(),
    family,
    context_length: numberOrNull(model.context_length, model.context_window, model.max_context_length, model.top_provider?.context_length),
    max_output_tokens: numberOrNull(model.max_output_tokens, model.max_completion_tokens, model.top_provider?.max_completion_tokens),
    pricing: { ...pricing, ...(prompt != null ? { prompt } : {}), ...(completion != null ? { completion } : {}) },
    ...(Object.keys(normalizedArchitecture).length ? { architecture: normalizedArchitecture } : {}),
    ...(Object.keys(normalizedCapabilities).length ? { capabilities: normalizedCapabilities } : {}),
    active: boolOrNull(model.active, model.status === 'active' ? true : null),
    speed: numberOrNull(model.speed, model.tokens_per_second),
    latency: numberOrNull(model.latency, model.latency_ms),
    metadata_source: 'provider_api'
  }, providerType);
}

function normalizedCatalog(data, providerType = 'custom') {
  const source = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const seen = new Set();
  return source.map(item => typeof item === 'string' ? { id: item } : item)
    .filter(item => item && typeof item === 'object')
    .map(item => ({ ...item, id: String(item.id || '').trim() }))
    .filter(item => item.id && item.id.length <= 300 && !seen.has(item.id) && seen.add(item.id))
    .map(item => canonicalModel(item, providerType));
}

// Também corrige catálogos já armazenados antes deste enriquecimento, para que
// a atualização do servidor resolva a interface sem exigir que a pessoa apague
// e cadastre novamente a chave.
export function enrichProviderCatalog(models, providerType = 'custom') {
  return normalizedCatalog(models, normalizeProviderType(providerType));
}

async function responseError(response, providerType = 'custom') {
  if (isRedirect(response)) return REDIRECT_MSG;
  let detail = '';
  try {
    const body = await response.json();
    detail = sanitizeUpstreamDetail(body?.error?.message || body?.message || body?.error || '');
  } catch {}
  if (response.status === 401) {
    if (providerType === 'alibaba') return 'A chave foi recusada. Confirme que a URL base é o campo openAiCompatible do mesmo CSV, workspace e região.';
    return 'A chave foi recusada pelo provedor.';
  }
  if (response.status === 403) {
    if (providerType === 'alibaba' && /unpurchased|accessdenied/i.test(String(detail))) {
      return `A chave foi reconhecida, mas o serviço ou modelo ainda não está habilitado/comprado neste workspace. ${detail}`.slice(0, 300);
    }
    return detail ? `O provedor recusou o acesso: ${detail}` : 'A chave não tem permissão para este recurso no provedor.';
  }
  return detail ? `O provedor respondeu com HTTP ${response.status}: ${detail}` : `O provedor respondeu com HTTP ${response.status}.`;
}

export async function importProviderCatalog({ apiKey, baseURL, providerType = 'custom', modelHint = '', allowModelValidation = true, fetchImpl = fetch, clientFactory = createAiClient, timeoutMs = 15000, resolveImpl } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Informe a chave de API.');
  const type = normalizeProviderType(providerType);
  const base = normalizeBaseURL(baseURL, type);
  // Antes de QUALQUER requisição (inclusive a validação por chat mais abaixo):
  // a URL tem de apontar para fora da rede interna.
  await assertProviderUrlAllowed(base, resolveImpl ? { resolveImpl } : {});
  let listFailure = null;
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (isRedirect(response)) {
      // Sem fallback de validação por chat: o SDK SEGUE redirecionamentos, e
      // um host público poderia usar o 30x para mandar o backend à rede interna.
      const redirect = new Error(REDIRECT_MSG);
      redirect.code = 'PROVIDER_REDIRECT';
      throw redirect;
    }
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
  if (listFailure?.code === 'PROVIDER_REDIRECT') throw listFailure;
  if (!allowModelValidation) throw listFailure;
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
    // A mensagem do SDK costuma embutir o corpo da resposta do provedor:
    // passa pela mesma sanitização (curta, sem tags/quebras).
    const detail = sanitizeUpstreamDetail(String(error?.message || error?.error?.message || ''));
    const status = Number(error?.status || error?.response?.status || 0);
    const message = status === 401
      ? (type === 'alibaba'
          ? 'A chave foi recusada. Confirme que a URL base é o campo openAiCompatible do mesmo CSV, workspace e região.'
          : 'A chave foi recusada pelo provedor.')
      : status === 403 && type === 'alibaba' && /unpurchased|accessdenied/i.test(detail)
        ? `A chave foi reconhecida, mas o serviço ou modelo ainda não está habilitado/comprado neste workspace. ${detail}`
        : (detail || listFailure?.message || 'Não foi possível validar a chave.');
    throw new Error(String(message).slice(0, 300));
  }
}

async function balanceResponse(response) {
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}

export async function fetchProviderBalance({ apiKey, baseURL, providerType, fetchImpl = fetch, timeoutMs = 12000, resolveImpl } = {}) {
  const type = normalizeProviderType(providerType);
  const preset = PROVIDER_PRESETS[type];
  if (!preset.balance) return { available: false, reason: 'unsupported' };
  const base = normalizeBaseURL(baseURL, type);
  const endpoint = preset.balance === 'openrouter' ? `${base}/credits` : `${base}/user/balance`;
  try {
    // A URL base de um tipo com saldo também é editável: mesma guarda de SSRF.
    await assertProviderUrlAllowed(base, resolveImpl ? { resolveImpl } : {});
    const data = await balanceResponse(await fetchImpl(endpoint, {
      headers: { Authorization: `Bearer ${String(apiKey || '').trim()}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    }));
    if (type === 'openrouter') {
      const value = data?.data || data;
      const total = numberOrNull(value?.total_credits);
      const used = numberOrNull(value?.total_usage);
      return { available: true, currency: 'USD', total, used, balance: total != null && used != null ? total - used : null };
    }
    const entries = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
    return { available: Boolean(data?.is_available ?? entries.length), currency: entries[0]?.currency || 'USD', balance: numberOrNull(entries[0]?.total_balance), details: entries };
  } catch (error) {
    return { available: false, reason: 'provider_error', error: String(error?.message || 'Saldo indisponível.').slice(0, 240) };
  }
}
