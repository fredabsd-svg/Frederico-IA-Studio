// BYOK (Bring Your Own Key): resolve o provedor de IA de cada usuário.
// Ordem de prioridade:
//   1. chave PRÓPRIA (cifrada em user_settings);
//   2. MODO GRATUITO (usuário aderiu no primeiro acesso e o servidor tem
//      FREE_TIER_API_KEY) — chave da plataforma, com limites e allowlist de
//      modelos (ver freeTier.js);
//   3. chave do servidor (.env) quando permitido por ALLOW_SHARED_KEY.
//
// ALLOW_SHARED_KEY: padrão LIGADO (instância pessoal — a chave do .env vale para
// quem não cadastrou a própria, sem quebrar nada). Numa SaaS pública, ponha
// ALLOW_SHARED_KEY=false para que o servidor NÃO pague a conta de ninguém —
// aí cada usuário usa o modo gratuito ou cadastra a própria chave.
import OpenAI from 'openai';
import { db } from './db.js';
import { decryptSecret } from './crypto.js';
import { getFreeTierConfig, isFreeModeOptedIn } from './freeTier.js';

const SERVER_KEY = process.env.DEEPSEEK_API_KEY || '';
const SERVER_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const SERVER_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const ALLOW_SHARED = process.env.ALLOW_SHARED_KEY !== 'false';

export async function getUserProvider(userId) {
  let apiKey = '', baseURL = SERVER_BASE, model = SERVER_MODEL, source = 'none';
  let freeMode = false;
  try {
    const row = userId && await db.prepare('SELECT api_key_enc, base_url, model, free_mode FROM user_settings WHERE user_id=?').get(userId);
    freeMode = Number(row?.free_mode || 0) === 1;
    if (row?.api_key_enc) {
      const dec = decryptSecret(row.api_key_enc);
      if (dec) { apiKey = dec; source = 'user'; if (row.base_url) baseURL = row.base_url; if (row.model) model = row.model; }
    } else if (row) {
      // Usuário salvou base_url/model sem chave própria — respeita esses.
      if (row.base_url) baseURL = row.base_url;
      if (row.model) model = row.model;
    }
  } catch {}
  // MODO GRATUITO: sem chave própria, quem aderiu usa a chave da plataforma.
  // O modelo é SEMPRE um da allowlist gratuita (o usuário não escolhe um modelo
  // pago na conta da casa); os demais habilitados viram cadeia de reserva.
  if (!apiKey && freeMode) {
    const free = await getFreeTierConfig();
    if (free.configured && free.enabled) {
      return {
        hasKey: true,
        source: 'free',
        baseURL: free.baseURL,
        model: free.models[0],
        freeModels: free.models,
        fallbackModels: free.models.slice(1),
        providerName: free.providerName,
        apiKey: free.apiKey,
        client: new OpenAI({ apiKey: free.apiKey, baseURL: free.baseURL }),
      };
    }
  }
  if (!apiKey && ALLOW_SHARED && SERVER_KEY) { apiKey = SERVER_KEY; source = 'server'; }
  return {
    hasKey: !!apiKey,
    source,          // 'user' | 'free' | 'server' | 'none'
    baseURL,
    model,
    apiKey,          // chave crua (uso interno no servidor: ex. listar o catálogo do provedor do usuário)
    client: apiKey ? new OpenAI({ apiKey, baseURL }) : null,
  };
}

// Reexporta a checagem de adesão para os call sites que já importam daqui.
export { isFreeModeOptedIn };
