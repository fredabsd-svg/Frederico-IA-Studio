-- Copiloto — caixa de documentos própria (separada dos anexos das conversas).
--
-- Aqui o copiloto guarda o que produz ou coleta a pedido do usuário: textos
-- revisados (do balão proativo de escrita), logs de ações, prints e notas. É um
-- armazenamento independente do fluxo de arquivos das conversas (tabela files),
-- para que o material do copiloto tenha um lugar previsível e fácil de achar.

CREATE TABLE IF NOT EXISTS copilot_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'texto', -- texto | texto_revisado | log | print | relatorio
  name TEXT NOT NULL,
  mime TEXT,                          -- tipo do conteúdo (text/plain, text/markdown...)
  content TEXT,                       -- conteúdo textual guardado inline
  meta TEXT,                          -- JSON opcional (origem, tokens, etc.)
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_copilot_docs_user ON copilot_documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_docs_kind ON copilot_documents(user_id, kind);
