-- Histórico de mudanças AUTOMÁTICAS do catálogo de modelos (rotina de sync e
-- atualização manual). Guarda o antes/depois, a fonte e a data de cada
-- alteração relevante, para auditoria — o pedido explícito da Fase 2.
CREATE TABLE IF NOT EXISTS model_catalog_history (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  provider_id TEXT,
  provider_name TEXT,
  model_id TEXT,
  change_type TEXT NOT NULL,   -- added | removed | changed
  field TEXT,                  -- context | price | status | capabilities.vision | ...
  old_value TEXT,
  new_value TEXT,
  source TEXT,                 -- provider_api | curated | family
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_catalog_history_user
  ON model_catalog_history(user_id, created_at DESC);
