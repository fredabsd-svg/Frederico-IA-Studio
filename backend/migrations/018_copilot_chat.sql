-- Copiloto — chat próprio com contexto 100% ISOLADO do chat principal.
--
-- O copiloto (o "colega de trabalho" representado pelo avatar) passa a ter uma
-- conversa própria, separada de conversations/messages. Nada do que é dito aqui
-- vaza para o chat principal, e nada do chat principal entra aqui: são dois
-- espaços de memória distintos. Uma linha em copilot_conversations por thread
-- (o MVP mantém uma única thread contínua por usuário) e o histórico em
-- copilot_messages.

CREATE TABLE IF NOT EXISTS copilot_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_copilot_conv_user ON copilot_conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS copilot_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,                 -- user | assistant
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_copilot_msg_conv ON copilot_messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_copilot_msg_user ON copilot_messages(user_id, created_at DESC);
