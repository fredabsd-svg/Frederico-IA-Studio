-- Especificação de produção (seções 5 e 8): cota diária de tokens por usuário
-- e trilha de auditoria de chamadas externas e downloads.

-- usage_daily já conta mensagens/dia; passa a acumular também os tokens
-- consumidos no dia (soma de total_tokens de cada resposta), permitindo
-- aplicar RATE_TOKENS_PER_DAY sem varrer a tabela usage inteira.
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS tokens BIGINT NOT NULL DEFAULT 0;

-- Toda chamada a recurso EXTERNO (web_search, web_fetch, consultar_cnpj,
-- generate_image) e todo download de arquivo ficam registrados: quem, em qual
-- conversa, qual recurso e um resumo do parâmetro. user_id sem FK proposital:
-- a trilha sobrevive à exclusão da conta (exigência de auditoria).
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  conversation_id TEXT,
  kind TEXT NOT NULL,               -- ex.: tool:web_fetch, download
  detail TEXT,                      -- resumo do parâmetro (URL, query, caminho)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_log(user_id, created_at);
