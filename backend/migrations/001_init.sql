-- Migration 001 — schema inicial em PostgreSQL.
-- Reproduz o schema que antes era criado pelo better-sqlite3 em db.js.
-- Decisões de tipos (para preservar o comportamento atual do app):
--   * ids: TEXT (nanoid), como antes.
--   * datas (created_at/updated_at/...): TEXT com ISO string, como antes —
--     o código gera com now() (new Date().toISOString()) e ordena/compara
--     como string. NÃO usar TIMESTAMPTZ para não mudar o formato lido.
--   * campos JSON (tools, personality, memory_meta, tags...): TEXT — o código
--     faz JSON.parse/stringify na mão. NÃO usar JSONB para não mudar a leitura.
--   * embeddings: BYTEA (antes BLOB) — Buffers Float32; pg devolve como Buffer.
--   * flags 0/1: INTEGER, idêntico ao SQLite.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  client_id TEXT,
  summary_short TEXT,
  summary_long TEXT,
  tags TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_meta TEXT,
  created_at TEXT NOT NULL,
  -- Ordem de inserção estável e monotônica. Substitui o `rowid` implícito do
  -- SQLite, usado como critério de desempate na ordenação das mensagens e para
  -- truncar a conversa "desta mensagem em diante" (edição estilo ChatGPT).
  seq BIGSERIAL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT,
  model TEXT,
  system_prompt TEXT NOT NULL,
  tools TEXT,          -- JSON: lista de ferramentas permitidas
  personality TEXT,    -- JSON: { form, det, criat }
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',  -- 'global' ou o id de um assistente
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  type TEXT DEFAULT 'manual',
  source_type TEXT DEFAULT 'manual',
  source_id TEXT,
  importance INTEGER DEFAULT 3,
  confidence REAL DEFAULT 1,
  pinned INTEGER DEFAULT 0,
  tags TEXT,
  updated_at TEXT,
  embedding BYTEA
);

CREATE TABLE IF NOT EXISTS memory_suggestions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'fato',
  source_type TEXT DEFAULT 'auto',
  source_id TEXT,
  importance INTEGER DEFAULT 3,
  confidence REAL DEFAULT 1,
  tags TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  approved_memory_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  assistant_id TEXT,
  model TEXT,
  web_search INTEGER DEFAULT 0,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|error|canceled
  progress_text TEXT,
  result_text TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  assistant_id TEXT,
  model TEXT,
  kind TEXT DEFAULT 'chat',            -- 'chat' ou 'orquestrador'
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_chunks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,               -- NULL para conteúdo importado
  source_title TEXT,                  -- rótulo de origem (ex.: título importado)
  scope TEXT DEFAULT 'global',        -- 'global' ou 'client:<id>' (isolamento por cliente)
  content TEXT NOT NULL,
  embedding BYTEA,
  token_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS pc_folders (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  host_path TEXT NOT NULL,
  writable INTEGER DEFAULT 0,   -- 0 = só leitura, 1 = leitura + organizar
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  assistant_id TEXT,
  model TEXT,
  client_id TEXT,
  web_search INTEGER DEFAULT 0,
  cadence TEXT NOT NULL DEFAULT 'monthly',  -- daily | weekly | monthly
  day INTEGER DEFAULT 1,                     -- dia do mês (monthly) ou da semana 0-6 (weekly)
  hour INTEGER DEFAULT 8,                     -- hora do dia (0-23)
  enabled INTEGER DEFAULT 1,
  last_run TEXT,                             -- data (YYYY-MM-DD) da última execução
  created_at TEXT NOT NULL
);

-- Índices (aceleram buscas quando o banco cresce)
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_files_conv ON files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chunks_conv ON conversation_chunks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chunks_scope ON conversation_chunks(scope);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope);
CREATE INDEX IF NOT EXISTS idx_memory_source ON memory(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_usage_conv ON usage(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_client ON conversations(client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
