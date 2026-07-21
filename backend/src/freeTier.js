// Modo gratuito: o BACKEND atende usuários sem chave própria usando a chave da
// PLATAFORMA (FREE_TIER_API_KEY), que vive só no .env do servidor — nunca no
// frontend, nunca no repositório. O cliente fala com /api; só o servidor fala
// com o provedor de IA.
//
// Proteções embutidas (obrigatórias num free tier público):
//   * limite diário de mensagens por usuário (global + sobreposição individual);
//   * freio por minuto (contra rajadas/scripts);
//   * allowlist de modelos (o usuário não gasta a chave da casa em modelo pago);
//   * bloqueio individual por abuso (painel admin);
//   * registro de consumo/erros por usuário (free_tier_usage / free_tier_events);
//   * fila global com concorrência limitada (freeQueue.js).
//
// Configuração pelo .env (ver .env.example) com sobreposições do painel admin
// gravadas em free_tier_settings (valem sem reiniciar o servidor).
import { nanoid } from 'nanoid';
import { db, now } from './db.js';
import { resolveScheduleTimeZone, scheduleDateKey } from './scheduling.js';

const TZ = resolveScheduleTimeZone(process.env.APP_TIMEZONE);

// ---- Configuração base (.env) ----
const ENV_KEY = (process.env.FREE_TIER_API_KEY || '').trim();
const ENV_BASE = (process.env.FREE_TIER_BASE_URL || 'https://openrouter.ai/api/v1').trim();
const ENV_PROVIDER_NAME = (process.env.FREE_TIER_PROVIDER_NAME || defaultProviderName(ENV_BASE)).trim();
// Modelos gratuitos oferecidos, em ordem de preferência (o 1º habilitado é o
// padrão; os demais são a cadeia de reserva quando o provedor devolve 429/5xx).
const ENV_MODELS = String(process.env.FREE_TIER_MODELS || [
  // Padrões pensados para o OpenRouter (sufixo :free = custo zero). ATENÇÃO: a
  // lista :free ROTACIONA sem aviso — modelos entram e SAEM do ar. Quando um id
  // sai, o provedor responde 404 ("Modelo não encontrado"); por isso o app agora
  // faz FAILOVER para o próximo desta lista (ver loop.js/isModelUnavailableError).
  // Ainda assim, confira periodicamente em openrouter.ai/models?q=:free e ajuste
  // FREE_TIER_MODELS no .env — estes padrões podem envelhecer.
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);
const ENV_MSGS_PER_DAY = Math.max(1, Number(process.env.FREE_TIER_MSGS_PER_DAY || 20));
const ENV_MSGS_PER_MIN = Math.max(1, Number(process.env.FREE_TIER_MSGS_PER_MIN || 4));
const ENV_ENABLED = process.env.FREE_TIER_ENABLED !== 'false'; // ligado se houver chave

function defaultProviderName(base) {
  if (/openrouter\.ai/i.test(base)) return 'OpenRouter';
  if (/deepseek\.com/i.test(base)) return 'DeepSeek';
  if (/groq\.com/i.test(base)) return 'Groq';
  if (/googleapis\.com|generativelanguage/i.test(base)) return 'Google AI';
  if (/mistral\.ai/i.test(base)) return 'Mistral';
  if (/localhost|127\.0\.0\.1|ollama/i.test(base)) return 'Modelo local';
  return 'Provedor gratuito';
}

// O modo gratuito existe quando o servidor tem uma chave dedicada a ele.
export function freeTierConfigured() { return Boolean(ENV_KEY); }

// ---- Sobreposições do admin (free_tier_settings), com cache em memória ----
// Chaves: enabled ('0'/'1'), msgs_per_day (número), disabled_models (JSON [ids]).
let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_TTL_MS = 30_000;

async function loadAdminSettings() {
  if (settingsCache && Date.now() - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;
  const rows = await db.prepare('SELECT key, value FROM free_tier_settings').all().catch(() => []);
  const raw = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  let disabled = [];
  try { disabled = JSON.parse(raw.disabled_models || '[]'); } catch {}
  settingsCache = {
    enabled: raw.enabled === undefined ? ENV_ENABLED : raw.enabled === '1',
    msgsPerDay: Math.max(1, Number(raw.msgs_per_day || ENV_MSGS_PER_DAY)),
    disabledModels: Array.isArray(disabled) ? disabled : []
  };
  settingsCacheAt = Date.now();
  return settingsCache;
}

export function invalidateFreeTierSettingsCache() { settingsCache = null; }

export async function saveFreeTierSetting(key, value) {
  await db.prepare(`INSERT INTO free_tier_settings (key, value) VALUES (?,?)
    ON CONFLICT (key) DO UPDATE SET value=excluded.value`).run(key, value);
  invalidateFreeTierSettingsCache();
}

// ---- Estado efetivo do modo gratuito ----
export async function getFreeTierConfig() {
  if (!freeTierConfigured()) return { configured: false, enabled: false };
  const admin = await loadAdminSettings();
  const models = ENV_MODELS.filter(m => !admin.disabledModels.includes(m));
  return {
    configured: true,
    enabled: admin.enabled && models.length > 0,
    apiKey: ENV_KEY,
    baseURL: ENV_BASE,
    providerName: ENV_PROVIDER_NAME,
    models,                                  // habilitados, em ordem de preferência
    allModels: ENV_MODELS,                   // catálogo completo (painel admin)
    disabledModels: admin.disabledModels,
    msgsPerDay: admin.msgsPerDay,
    msgsPerMin: ENV_MSGS_PER_MIN
  };
}

// ---- Adesão do usuário (user_settings.free_mode) ----
export async function setFreeModeOptIn(userId, enable) {
  const t = now();
  await db.prepare(`INSERT INTO user_settings (user_id, free_mode, created_at, updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT (user_id) DO UPDATE SET free_mode=excluded.free_mode, updated_at=excluded.updated_at`)
    .run(userId, enable ? 1 : 0, t, t);
}

export async function isFreeModeOptedIn(userId) {
  if (!userId) return false;
  const row = await db.prepare('SELECT free_mode FROM user_settings WHERE user_id=?').get(userId).catch(() => null);
  return Number(row?.free_mode || 0) === 1;
}

// ---- Bloqueio por abuso ----
export async function isFreeTierBlocked(userId) {
  if (!userId) return false;
  const row = await db.prepare('SELECT 1 ok FROM free_tier_blocks WHERE user_id=?').get(userId).catch(() => null);
  return Boolean(row);
}

export async function blockFreeTierUser(userId, reason) {
  await db.prepare(`INSERT INTO free_tier_blocks (user_id, reason, created_at) VALUES (?,?,?)
    ON CONFLICT (user_id) DO UPDATE SET reason=excluded.reason, created_at=excluded.created_at`)
    .run(userId, String(reason || '').slice(0, 300) || null, now());
}

export async function unblockFreeTierUser(userId) {
  await db.prepare('DELETE FROM free_tier_blocks WHERE user_id=?').run(userId);
}

// ---- Limites e consumo ----
function dayKey() { return scheduleDateKey(new Date(), TZ); }

// Horário (ISO) em que o contador diário zera: a próxima meia-noite no fuso do
// app. Aproximação por Intl (DST pode deslocar ±1h — aceitável para exibição).
export function nextResetIso() {
  const current = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(current)
    .filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const elapsed = (Number(parts.hour) * 3600) + (Number(parts.minute) * 60) + Number(parts.second);
  return new Date(current.getTime() + (86_400 - elapsed) * 1000).toISOString();
}

export async function freeTierUserLimit(userId) {
  const config = await getFreeTierConfig();
  const override = await db.prepare('SELECT msgs_per_day FROM free_tier_user_limits WHERE user_id=?').get(userId).catch(() => null);
  const value = Number(override?.msgs_per_day);
  return Number.isFinite(value) && value > 0 ? value : (config.msgsPerDay || ENV_MSGS_PER_DAY);
}

export async function freeTierUsedToday(userId) {
  const row = await db.prepare('SELECT msgs, tokens FROM free_tier_usage WHERE user_id=? AND day=?')
    .get(userId, dayKey()).catch(() => null);
  return { msgs: Number(row?.msgs || 0), tokens: Number(row?.tokens || 0) };
}

// Freio por minuto: contagem dos eventos gravados no último minuto. Simples e
// suficiente — cada resposta free gera um evento em free_tier_events.
const minuteHits = new Map(); // userId -> [timestamps ms]
function bumpMinuteWindow(userId, limit) {
  const timestamps = (minuteHits.get(userId) || []).filter(t => Date.now() - t < 60_000);
  if (timestamps.length >= limit) { minuteHits.set(userId, timestamps); return false; }
  timestamps.push(Date.now());
  minuteHits.set(userId, timestamps);
  return true;
}

// Checa TODOS os limites antes de atender uma mensagem no modo gratuito.
// Devolve null (pode prosseguir) ou { code, error, resetAt, used, limit }.
export async function enforceFreeTierLimits(userId) {
  const config = await getFreeTierConfig();
  if (!config.enabled) {
    return { code: 'free_disabled', error: 'O modo gratuito está temporariamente desativado. Você pode configurar a sua própria chave de API em Configurações → Provedor de IA para continuar.' };
  }
  if (await isFreeTierBlocked(userId)) {
    return { code: 'free_blocked', error: 'Seu acesso ao modo gratuito foi suspenso por uso fora do esperado. Você ainda pode usar o aplicativo com a sua própria chave de API (Configurações → Provedor de IA).' };
  }
  const limit = await freeTierUserLimit(userId);
  const used = await freeTierUsedToday(userId);
  if (used.msgs >= limit) {
    return {
      code: 'free_limit',
      error: `O limite gratuito de hoje foi atingido (${limit} mensagens). Você poderá continuar quando o limite for renovado ou adicionar sua própria chave de API para continuar usando o aplicativo agora.`,
      resetAt: nextResetIso(), used: used.msgs, limit
    };
  }
  if (!bumpMinuteWindow(userId, config.msgsPerMin)) {
    return { code: 'free_minute', error: 'Muitas mensagens seguidas no modo gratuito. Aguarde um instante e tente novamente.' };
  }
  return null;
}

// Contabiliza uma resposta atendida no modo gratuito (contador diário atômico).
export async function bumpFreeTierUsage(userId, tokens = 0) {
  await db.prepare(`INSERT INTO free_tier_usage (user_id, day, msgs, tokens) VALUES (?,?,1,?)
    ON CONFLICT (user_id, day) DO UPDATE SET msgs = free_tier_usage.msgs + 1, tokens = free_tier_usage.tokens + excluded.tokens`)
    .run(userId, dayKey(), Math.max(0, Number(tokens) || 0));
}

// Registro de auditoria (alimenta o painel admin e a análise de abuso).
export async function logFreeTierEvent({ userId, model, status, detail = '', tokens = 0 }) {
  try {
    await db.prepare('INSERT INTO free_tier_events (id,user_id,provider,model,status,detail,tokens,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(nanoid(), userId || null, ENV_PROVIDER_NAME, model || null, status, String(detail || '').slice(0, 500) || null, Math.max(0, Number(tokens) || 0), now());
  } catch (e) {
    console.error('[free-tier] falha ao registrar evento:', e.message);
  }
}

// ---- Status para o frontend (indicadores de transparência) ----
export async function freeTierStatusFor(userId, { optedIn, source } = {}) {
  const config = await getFreeTierConfig();
  if (!config.configured) return { configured: false };
  const opted = optedIn ?? await isFreeModeOptedIn(userId);
  const limit = await freeTierUserLimit(userId);
  const used = await freeTierUsedToday(userId);
  return {
    configured: true,
    enabled: config.enabled,
    optedIn: opted,
    active: source ? source === 'free' : undefined,
    provider: config.providerName,
    model: config.models[0] || null,
    models: config.models,
    usedToday: used.msgs,
    limitPerDay: limit,
    remaining: Math.max(0, limit - used.msgs),
    resetAt: nextResetIso(),
    blocked: await isFreeTierBlocked(userId)
  };
}
