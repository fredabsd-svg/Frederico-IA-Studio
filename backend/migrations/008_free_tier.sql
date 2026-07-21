-- Migration 007 — Modo gratuito (free tier servido pelo backend).
--
-- O usuário sem chave própria pode optar pelo modo gratuito: o BACKEND fala com
-- o provedor usando a chave da plataforma (FREE_TIER_API_KEY, só no .env do
-- servidor — nunca no frontend). Estas tabelas guardam a adesão, o consumo, os
-- eventos (auditoria/abuso), bloqueios e as configurações editáveis pelo admin.

-- Adesão ao modo gratuito (escolhida no primeiro acesso; 0 = não aderiu).
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS free_mode INTEGER NOT NULL DEFAULT 0;

-- Consumo diário no modo gratuito (contador por usuário e por dia, no fuso do
-- app). Separado de usage_daily: aquele conta TODAS as mensagens (limite geral
-- da instância); este conta só as atendidas pela chave da plataforma.
CREATE TABLE IF NOT EXISTS free_tier_usage (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                -- data YYYY-MM-DD (fuso APP_TIMEZONE)
  msgs INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Registro de consumo/erros do modo gratuito (alimenta o painel administrativo
-- e a detecção de abuso). Uma linha por requisição concluída ou falhada.
CREATE TABLE IF NOT EXISTS free_tier_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  provider TEXT,                    -- rótulo do provedor (ex.: OpenRouter)
  model TEXT,                       -- modelo que atendeu (após fallback, se houve)
  status TEXT NOT NULL,             -- ok | error | limited | blocked | cancelled
  detail TEXT,                      -- mensagem de erro/observação (curta)
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_free_events_user ON free_tier_events(user_id);
CREATE INDEX IF NOT EXISTS idx_free_events_time ON free_tier_events(created_at);

-- Usuários bloqueados no modo gratuito (por abuso). O bloqueio vale SÓ para a
-- chave da plataforma — com chave própria a pessoa continua usando normalmente.
CREATE TABLE IF NOT EXISTS free_tier_blocks (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- Configurações do modo gratuito editáveis no painel admin (sobrepõem o .env
-- sem reiniciar o servidor). Chaves usadas: enabled, msgs_per_day,
-- disabled_models (JSON de ids desativados).
CREATE TABLE IF NOT EXISTS free_tier_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Limite individual por usuário (sobrepõe o limite diário global quando definido).
CREATE TABLE IF NOT EXISTS free_tier_user_limits (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  msgs_per_day INTEGER,
  updated_at TEXT NOT NULL
);
