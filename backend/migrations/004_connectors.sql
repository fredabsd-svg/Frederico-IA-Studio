-- Migration 004 — Conectores de serviços externos por usuário (GitHub etc.).
-- O token de cada serviço fica CIFRADO (AES-256-GCM, mesma ENCRYPTION_KEY do
-- BYOK) e nunca é devolvido em texto claro pela API. Uma linha por
-- (usuário, provedor); "github" é o primeiro provedor suportado.

CREATE TABLE IF NOT EXISTS user_connectors (
  user_id       TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  token_enc     TEXT,
  account_login TEXT,
  account_name  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_connectors_user ON user_connectors(user_id);
