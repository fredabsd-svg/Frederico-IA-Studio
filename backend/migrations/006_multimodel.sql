-- Sistema multimodelo: duas ou mais IAs trabalhando na mesma mensagem.
--
-- 1) messages.multi_meta: JSON com o resultado individual de cada modelo
--    (função, status, texto, tokens, custo, tempo) para a interface reconstruir
--    os cartões por modelo ao reabrir a conversa.
-- 2) model_teams: equipes predefinidas (presets) salvas pelo usuário — modelos,
--    funções, modo de colaboração, coordenador, rodadas, limites e orçamento.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS multi_meta TEXT;

CREATE TABLE IF NOT EXISTS model_teams (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_teams_user ON model_teams(user_id);
