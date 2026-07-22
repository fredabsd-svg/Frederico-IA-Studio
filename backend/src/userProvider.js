// Resolve a credencial dona de cada modelo. Um model ref tem a forma
// "<provider-id>::<model-id-real>"; isso evita colisões entre catálogos e faz
// os modos mono/multi-modelo usarem a chave correta em cada chamada.
import { createAiClient } from './aiClient.js';
import { db } from './db.js';
import { decryptSecret } from './crypto.js';
import { getFreeTierConfig, isFreeModeOptedIn } from './freeTier.js';
import { makeModelRef, parseModelRef } from './modelRef.js';

function parsedModels(row) {
  try { const models = JSON.parse(row?.models || '[]'); return Array.isArray(models) ? models : []; }
  catch { return []; }
}

function none(model = '') {
  return { hasKey: false, source: 'none', id: null, baseURL: '', model, modelRef: model, apiKey: '', client: null };
}

async function userRows(userId) {
  if (!userId) return [];
  try {
    return await db.prepare('SELECT * FROM user_ai_providers WHERE user_id=? ORDER BY created_at ASC').all(userId);
  } catch {
    return [];
  }
}

function providerFromRow(row, requestedModel = '') {
  const apiKey = decryptSecret(row.api_key_enc);
  if (!apiKey) return none(requestedModel);
  const models = parsedModels(row);
  const model = String(requestedModel || row.default_model || models[0]?.id || '').trim();
  return {
    hasKey: true,
    source: 'user',
    id: row.id,
    providerType: row.provider_type,
    providerName: row.name,
    baseURL: row.base_url,
    model,
    modelRef: makeModelRef(row.id, model),
    models,
    apiKey,
    client: createAiClient({ apiKey, baseURL: row.base_url })
  };
}

async function freeProvider(userId, requestedModel = '') {
  if (!await isFreeModeOptedIn(userId)) return null;
  const free = await getFreeTierConfig();
  if (!free.configured || !free.enabled) return null;
  const raw = (free.models || []).includes(requestedModel) ? requestedModel : free.models[0];
  return {
    hasKey: true,
    source: 'free',
    id: 'free',
    providerType: 'free',
    providerName: free.providerName,
    baseURL: free.baseURL,
    model: raw,
    modelRef: makeModelRef('free', raw),
    freeModels: free.models.map(model => makeModelRef('free', model)),
    fallbackModels: free.models.slice(1).map(model => makeModelRef('free', model)),
    apiKey: free.apiKey,
    client: createAiClient({ apiKey: free.apiKey, baseURL: free.baseURL })
  };
}

export async function getUserProvider(userId, requestedRef = '') {
  const parsed = parseModelRef(requestedRef);
  if (parsed.providerId === 'free') return (await freeProvider(userId, parsed.modelId)) || none(requestedRef);

  const rows = await userRows(userId);
  let row = parsed.providerId ? rows.find(item => item.id === parsed.providerId) : null;
  if (!row && parsed.modelId) {
    row = rows.find(item => parsedModels(item).some(model => model.id === parsed.modelId));
  }
  if (!row && !parsed.providerId) row = rows[0];
  if (row) return providerFromRow(row, parsed.modelId);

  // O modo gratuito é uma escolha explícita. Não há mais fallback implícito
  // para a chave compartilhada do servidor: conta nova sem chave vê zero modelos.
  return (await freeProvider(userId, parsed.modelId)) || none(requestedRef);
}

export { isFreeModeOptedIn };
