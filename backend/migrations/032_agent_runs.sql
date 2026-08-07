-- Runs duráveis do agente (Developer Workspace 3.0 — ADR 0002).
--
-- Antes desta migration, a EVIDÊNCIA de uma execução (etapas de ferramenta,
-- estados, pergunta pendente) vivia só no buffer SSE em memória e no estado do
-- React: um reload apagava o terminal e as etapas; um restart do backend
-- apagava até o run corrente, deixando o usuário sem saber o que aconteceu.
--
-- `agent_runs` é a entidade RUN (uma execução do agente numa conversa) e
-- `agent_run_events` é o event log append-only dela — somente os eventos que
-- valem reconstrução (tool_start, tool_result, run_state, input_required,
-- plan_update, files, file_checks). `delta`/`status`/`tool_progress` NÃO são
-- persistidos: são ruído de alta frequência cujo conteúdo final já está na
-- mensagem e nos resultados de ferramenta.
--
-- A retomada reaproveita o MESMO run_id (o checkpoint carrega o id), então os
-- eventos da retomada continuam a sequência do run original.

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id          TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'chat',   -- chat | multimodelo | orquestrador | resume
  state           TEXT NOT NULL DEFAULT 'waiting',-- vocabulário de executionState.js
  detail          TEXT,
  model           TEXT,
  message_id      TEXT,                           -- mensagem de assistente persistida ao final
  started_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  ended_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
  ON agent_runs(conversation_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user
  ON agent_runs(user_id, started_at);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id     TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,   -- JSON do evento (sem o campo type), truncado com aviso
  created_at TEXT NOT NULL,   -- timestamp REAL do servidor (a UI não fabrica relógio)
  PRIMARY KEY (run_id, seq)
);
