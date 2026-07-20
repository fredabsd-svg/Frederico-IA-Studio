-- Migration 005 — LGPD: registro de consentimento aos Termos de Uso e à
-- Política de Privacidade. Guarda o HISTÓRICO de aceites (uma linha por aceite,
-- não uma flag): se os termos mudarem de versão, um novo aceite é registrado e
-- o app volta a pedir concordância. O IP fica registrado como evidência do
-- aceite (art. 8º §1º da LGPD — ônus da prova do consentimento é do controlador).

CREATE TABLE IF NOT EXISTS user_consents (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,          -- versão dos termos aceita (ex.: 2026-07-20)
  ip          TEXT,                   -- IP de origem no momento do aceite
  user_agent  TEXT,                   -- navegador usado (evidência complementar)
  accepted_at TEXT NOT NULL           -- ISO string, como as demais datas do app
);

CREATE INDEX IF NOT EXISTS idx_user_consents_user ON user_consents(user_id, accepted_at DESC);
