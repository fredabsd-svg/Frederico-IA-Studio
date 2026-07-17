import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DB_PATH || './data/app.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_meta TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
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
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',  -- 'global' ou o id de um assistente
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
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
  embedding BLOB,
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
`);

// Migrações p/ bancos antigos: adiciona colunas se ainda não existirem
try { db.exec('ALTER TABLE files ADD COLUMN message_id TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN memory_meta TEXT'); } catch {}
try { db.exec('ALTER TABLE conversations ADD COLUMN client_id TEXT'); } catch {}
// Cor do assistente (nulo = cor padrão, escolhida pela ordem na lista)
try { db.exec('ALTER TABLE assistants ADD COLUMN color TEXT'); } catch {}
// Memória de longo prazo: novas colunas da tabela memory
try { db.exec("ALTER TABLE memory ADD COLUMN type TEXT DEFAULT 'manual'"); } catch {}
try { db.exec("ALTER TABLE memory ADD COLUMN source_type TEXT DEFAULT 'manual'"); } catch {}
try { db.exec('ALTER TABLE memory ADD COLUMN source_id TEXT'); } catch {}
try { db.exec('ALTER TABLE memory ADD COLUMN importance INTEGER DEFAULT 3'); } catch {}
try { db.exec('ALTER TABLE memory ADD COLUMN confidence REAL DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE memory ADD COLUMN pinned INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE memory ADD COLUMN tags TEXT'); } catch {}
try { db.exec('ALTER TABLE memory ADD COLUMN updated_at TEXT'); } catch {}
try { db.exec('ALTER TABLE memory ADD COLUMN embedding BLOB'); } catch {}
try { db.exec('ALTER TABLE memory_suggestions ADD COLUMN approved_memory_id TEXT'); } catch {}
try { db.exec("ALTER TABLE conversation_chunks ADD COLUMN scope TEXT DEFAULT 'global'"); } catch {}
// Resumos e tags automáticos das conversas
try { db.exec('ALTER TABLE conversations ADD COLUMN summary_short TEXT'); } catch {}
try { db.exec('ALTER TABLE conversations ADD COLUMN summary_long TEXT'); } catch {}
try { db.exec('ALTER TABLE conversations ADD COLUMN tags TEXT'); } catch {}

// Índices (criados APÓS as migrações, pois referenciam colunas adicionadas
// via ALTER acima). Aceleram buscas quando o banco cresce.
db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_files_conv ON files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chunks_conv ON conversation_chunks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chunks_scope ON conversation_chunks(scope);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope);
CREATE INDEX IF NOT EXISTS idx_memory_source ON memory(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_usage_conv ON usage(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_client ON conversations(client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`);

export function now() { return new Date().toISOString(); }
