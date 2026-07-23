-- Docling: camada central de compreensão documental. O documento é processado
-- UMA vez (Docling, no sandbox isolado/offline) e o resultado vira um artefato
-- CACHEADO por hash — reutilizado por chat, assistentes, modo dev e multi-modelo,
-- em vez de cada modelo re-extrair o PDF.
--
-- 1) files ganha `hash` (sha256 do conteúdo, base do cache/dedup) e `mime`.
-- 2) document_processings: o registro de cada processamento (a "fonte da verdade"
--    interna) — status, engine, OCR, contagem de páginas/tabelas, caminhos do
--    JSON completo / Markdown otimizado / chunks, métricas de tokens e erros.
--    Chaveado por (user_id, hash, config_version): se a configuração relevante
--    mudar, o config_version muda e o cache é naturalmente invalidado.

ALTER TABLE files ADD COLUMN IF NOT EXISTS hash TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS mime TEXT;
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);

CREATE TABLE IF NOT EXISTS document_processings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  file_id TEXT,                       -- referência à linha em files (quando houver)
  hash TEXT NOT NULL,                 -- sha256 do arquivo
  mime TEXT,
  filename TEXT,
  config_version TEXT NOT NULL,       -- versão do pipeline/opções (invalida o cache)
  engine TEXT,                        -- 'docling' | 'fallback'
  status TEXT NOT NULL DEFAULT 'queued', -- queued|processing|done|done_warnings|partial|failed
  ocr_used INTEGER NOT NULL DEFAULT 0,   -- 0/1: houve OCR
  page_count INTEGER,
  table_count INTEGER,
  json_path TEXT,                     -- caminho do Docling JSON completo (fonte da verdade)
  md_path TEXT,                       -- caminho do Markdown otimizado (enviado à IA)
  chunks_path TEXT,                   -- caminho dos chunks semânticos (JSON)
  stats TEXT,                         -- JSON: métricas (tokens antes/depois, tempo, alertas...)
  token_original INTEGER,             -- tokens estimados do conteúdo integral
  token_optimized INTEGER,            -- tokens estimados do conteúdo otimizado
  warnings TEXT,                      -- JSON: páginas/elementos com alerta
  error TEXT,                         -- mensagem de falha (quando status=failed)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Uma linha por (usuário, hash, versão de config): o UPSERT do cache se apoia nisto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_docproc_cache ON document_processings(user_id, hash, config_version);
CREATE INDEX IF NOT EXISTS idx_docproc_conv ON document_processings(conversation_id);
CREATE INDEX IF NOT EXISTS idx_docproc_status ON document_processings(user_id, status);
