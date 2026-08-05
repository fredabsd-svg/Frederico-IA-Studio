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

// Resolve um id de modelo "nu" (sem prefixo `<provedor>::`) para uma referência
// completa (`<provedor>::<modelo>`) usando os provedores cadastrados do usuário.
// É o que seed/assistants chamam ao gravar uma nova linha: o usuário escolhe o
// modelo no seletor (id do catálogo de um provedor), mas para evitar o chute
// silencioso do `rows[0]` na próxima chamada, gravamos a referência completa.
//
// Devolve `null` quando o modelo não está em catálogo nenhum — nesse caso o
// caller decide se persiste com `model_ref=NULL` (legado, tratado em runtime
// com erro claro) ou se recusa a operação.
export async function resolveBareModelToRef(userId, bareModel) {
  const model = String(bareModel || '').trim();
  if (!model) return null;
  const parsed = parseModelRef(model);
  // Já tem a forma completa? nada a resolver.
  if (parsed.providerId) return model;
  const rows = await userRows(userId);
  const matches = rows.filter(row => parsedModels(row).some(item => item?.id === parsed.modelId));
  if (matches.length === 1) return makeModelRef(matches[0].id, parsed.modelId);
  // Múltiplos provedores com o mesmo id de modelo (ex.: OpenRouter E DeepSeek
  // ambos listando "deepseek-chat"): a regra é "o que tem chave utilizável
  // primeiro" — mesma heurística de `getUserProvider` no caminho sem provedor
  // pedido. Consistência com o runtime.
  const usable = matches.find(row => decryptSecret(row.api_key_enc));
  if (usable) return makeModelRef(usable.id, parsed.modelId);
  if (matches.length) return makeModelRef(matches[0].id, parsed.modelId);
  return null;
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
  // Sem provedor pedido E sem modelo identificável: padrão é o mais antigo
  // utilizável (defesa contra linha órfã na frente da fila). Este é o ÚNICO
  // caminho onde o `rows[0]` ainda vale — exatamente o cenário em que o
  // usuário não fez pedido nenhum e o app precisa de um modelo padrão.
  if (!row && !parsed.providerId && !parsed.modelId) {
    row = rows.find(item => decryptSecret(item.api_key_enc)) || rows[0];
  }
  if (row) {
    const provider = providerFromRow(row, parsed.modelId);
    // Provedor sem chave utilizável não pode ser beco sem saída: sem isto, o
    // modo gratuito — a única credencial que ainda restaria — nunca era tentado.
    if (provider.hasKey) return provider;
    return (await freeProvider(userId, parsed.modelId)) || provider;
  }

  // O usuário pediu um modelo específico (sem prefixo de provedor) e ele não
  // está em catálogo nenhum. Antes esta condição caía no `rows[0]`
  // silenciosamente — a causa-raiz do 401 do PR #140. Agora falhamos com
  // mensagem clara para que o caller (loop/seed/rota) possa decidir se recusa
  // a operação ou segue para o modo gratuito.
  if (parsed.modelId) {
    const stub = none(requestedRef);
    stub.attributionError = `O modelo "${parsed.modelId}" não está no catálogo de nenhum dos seus provedores. Atualize o catálogo em Configurações → Provedor de IA, escolha outro modelo, ou adicione um provedor que o sirva.`;
    return stub;
  }

  // O modo gratuito é uma escolha explícita. Não há mais fallback implícito
  // para a chave compartilhada do servidor: conta nova sem chave vê zero modelos.
  return (await freeProvider(userId, parsed.modelId)) || none(requestedRef);
}

// Todas as credenciais da conta, na ordem de cadastro e já decifradas — só as
// utilizáveis. Quem escolhe provedor por CAPACIDADE (geração de imagem) precisa
// ver o conjunto; `getUserProvider` responde por UM modelo e não serve para isso.
export async function listUserProviders(userId) {
  const rows = await userRows(userId);
  return rows.map(row => providerFromRow(row)).filter(provider => provider.hasKey);
}

export { isFreeModeOptedIn };
