-- Migration 003 — Fundação do multi-tenant (Fase 3).
-- Adiciona user_id às entidades de topo e cria as tabelas de BYOK e limites.
--
-- IMPORTANTE: nesta etapa o user_id é NULLABLE de propósito — assim a migration
-- pode rodar num banco existente sem quebrar, e o app continua funcionando
-- enquanto o código de isolamento é adicionado. Uma migration futura (004)
-- torna user_id NOT NULL, depois que todos os INSERTs passarem o dono.
--
-- Tabelas filhas (messages, files) NÃO ganham user_id: herdam o dono pela
-- conversa (conversation_id + ON DELETE CASCADE).

ALTER TABLE conversations        ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE assistants           ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE memory               ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE memory_suggestions   ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE clients              ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE templates            ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE tasks                ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE usage                ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE conversation_chunks  ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE pc_folders           ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE schedules            ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;

-- Índices por usuário (aceleram as listagens escopadas)
CREATE INDEX IF NOT EXISTS idx_conversations_user     ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_upd ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistants_user        ON assistants(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_user            ON memory(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_suggestions_user ON memory_suggestions(user_id);
CREATE INDEX IF NOT EXISTS idx_clients_user           ON clients(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_user         ON templates(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user             ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_user             ON usage(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user            ON conversation_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_pc_folders_user        ON pc_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_schedules_user         ON schedules(user_id);

-- BYOK: cada usuário cadastra a própria chave de API (criptografada) e suas
-- preferências de memória (antes globais na tabela settings).
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  api_key_enc TEXT,                 -- chave de API criptografada (iv:tag:cifra em base64)
  base_url TEXT,                    -- base compatível com OpenAI (ex.: OpenRouter)
  model TEXT,                       -- modelo padrão do usuário
  prefs TEXT,                       -- JSON com as preferências de memória do usuário
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Limite de uso diário por usuário (mensagens/dia).
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                -- data YYYY-MM-DD
  msgs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
