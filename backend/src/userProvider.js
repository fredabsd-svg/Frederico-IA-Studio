// BYOK (Bring Your Own Key): resolve o provedor de IA de cada usuário.
// A chave PRÓPRIA (guardada cifrada em user_settings) tem prioridade; se o
// usuário não cadastrou uma, cai para a chave do servidor (.env) quando
// permitido por ALLOW_SHARED_KEY.
//
// ALLOW_SHARED_KEY: padrão LIGADO (instância pessoal — a chave do .env vale para
// quem não cadastrou a própria, sem quebrar nada). Numa SaaS pública, ponha
// ALLOW_SHARED_KEY=false para que o servidor NÃO pague a conta de ninguém —
// aí cada usuário PRECISA cadastrar a própria chave em Configurações.
import { createAiClient } from './aiClient.js';
import { db } from './db.js';
import { decryptSecret } from './crypto.js';

const SERVER_KEY = process.env.DEEPSEEK_API_KEY || '';
const SERVER_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const SERVER_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const ALLOW_SHARED = process.env.ALLOW_SHARED_KEY !== 'false';

export async function getUserProvider(userId) {
  let apiKey = '', baseURL = SERVER_BASE, model = SERVER_MODEL, source = 'none';
  try {
    const row = userId && await db.prepare('SELECT api_key_enc, base_url, model FROM user_settings WHERE user_id=?').get(userId);
    if (row?.api_key_enc) {
      const dec = decryptSecret(row.api_key_enc);
      if (dec) { apiKey = dec; source = 'user'; if (row.base_url) baseURL = row.base_url; if (row.model) model = row.model; }
    } else if (row) {
      // Usuário salvou base_url/model sem chave própria — respeita esses.
      if (row.base_url) baseURL = row.base_url;
      if (row.model) model = row.model;
    }
  } catch {}
  if (!apiKey && ALLOW_SHARED && SERVER_KEY) { apiKey = SERVER_KEY; source = 'server'; }
  return {
    hasKey: !!apiKey,
    source,          // 'user' | 'server' | 'none'
    baseURL,
    model,
    client: apiKey ? createAiClient({ apiKey, baseURL }) : null,
  };
}
