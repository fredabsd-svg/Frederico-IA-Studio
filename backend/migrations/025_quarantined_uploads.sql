-- Quarentena de uploads aceitos com antivírus degradado (F-11).
--
-- O ClamAV pode estar fora do ar (modo fail-open) e os arquivos enviados nesse
-- intervalo são aceitos SEM verificação. Eles não podem ficar na pasta `uploads/`
-- como se estivessem validados — se o clamd estiver caído por causa de um
-- incidente de segurança, distribuir arquivos "verificados" é pior que
-- distribuição de malware (o selo some, mas a ameaça continua). A solução é
-- uma pasta de QUARANTENA (uploads/.quarantine/) e esta tabela para acompanhar
-- o que precisa ser REESCANEADO quando o antivírus voltar.
--
-- Estados:
--   pending    → ainda não foi tentado re-escanear (ou tentativa anterior falhou)
--   processing → um re-escaneamento está em andamento (anti-dupla-execução)
--   cleared    → o re-escaneamento passou (clean). O arquivo pode ser movido
--                 para uploads/ e o usuário notificado.
--   infected   → o re-escaneamento encontrou vírus. O arquivo foi removido.
--   stale      → re-escaneamento falhou por timeout/erro; tentar de novo depois.
--
-- Quando CLAMAV_REQUIRED=true, nenhum arquivo entra em quarentena (o upload é
-- recusado) — esta tabela fica vazia nesse modo.

CREATE TABLE IF NOT EXISTS quarantined_uploads (
  id              TEXT PRIMARY KEY,        -- mesmo id da tabela `files` (1:1)
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  storage_path    TEXT NOT NULL,           -- caminho relativo no workspace
  original_name   TEXT NOT NULL,
  mime            TEXT,
  size            INTEGER NOT NULL,
  hash            TEXT,                    -- SHA-256 (mesmo que files.hash)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | processing | cleared | infected | stale
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT,                    -- mensagem truncada da última falha
  virus_name      TEXT,                    -- quando infected
  quarantined_at  TEXT NOT NULL,
  cleared_at      TEXT                     -- quando cleared
);

CREATE INDEX IF NOT EXISTS idx_quarantined_status ON quarantined_uploads(status, quarantined_at);
CREATE INDEX IF NOT EXISTS idx_quarantined_user ON quarantined_uploads(user_id);
