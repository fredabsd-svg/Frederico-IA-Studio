-- Copiloto (Fase 1 — fundação): memória técnica persistente e auditoria.
--
-- 1) companion_incidents: a base de conhecimento por projeto (seções 12 e 18).
--    Cada incidente guarda problema, causa, arquivos, solução, comandos,
--    evidência, confiança, status, ocorrências e vínculo com commit/PR. É o que
--    permite "esse erro já ocorreu antes" sem depender da memória da conversa.
--    `signature` é a assinatura normalizada do erro (mesma ideia do errorDigest)
--    usada para correlacionar ocorrências do MESMO problema.
--
-- 2) companion_audit: o registro de TUDO que o agente fez (observou/leu/executou/
--    alterou) — ator (modelo), nível de permissão, se foi autorizado e o
--    resultado. Pré-requisito para os níveis de autonomia (seção 16).

CREATE TABLE IF NOT EXISTS companion_incidents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project TEXT,
  environment TEXT,
  service TEXT,
  kind TEXT NOT NULL DEFAULT 'bug',   -- bug|erro_recorrente|build|teste|dependencia|seguranca|desempenho
  severity TEXT NOT NULL DEFAULT 'media', -- info|baixa|media|alta|critica
  signature TEXT,                     -- assinatura normalizada (correlação)
  summary TEXT NOT NULL,              -- resumo em linguagem simples
  error_message TEXT,                 -- mensagem técnica original
  stack TEXT,                         -- stack trace, quando houver
  probable_cause TEXT,                -- causa raiz provável
  related_files TEXT,                 -- JSON: arquivos/funções envolvidos
  recent_changes TEXT,                -- JSON: alterações recentes relacionadas
  suggested_fix TEXT,                 -- estratégia(s) de correção
  commands TEXT,                      -- JSON: comandos recomendados
  evidence TEXT,                      -- JSON: evidências coletadas
  confidence INTEGER,                 -- 0..100: grau de confiança da análise
  status TEXT NOT NULL DEFAULT 'aberto', -- aberto|investigando|resolvido|reaberto|ignorado
  solution TEXT,                      -- solução aplicada
  result TEXT,                        -- resultado da correção (testes/validação)
  commit_ref TEXT,                    -- commit relacionado
  pr_ref TEXT,                        -- pull request relacionado
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_user ON companion_incidents(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_project ON companion_incidents(user_id, project);
CREATE INDEX IF NOT EXISTS idx_incidents_sig ON companion_incidents(user_id, signature);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON companion_incidents(user_id, status);

CREATE TABLE IF NOT EXISTS companion_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project TEXT,
  actor TEXT,                         -- quem agiu (modelo/agente/usuário)
  category TEXT NOT NULL DEFAULT 'observar', -- observar|ler|executar|alterar|instalar|git|notificar
  action TEXT NOT NULL,               -- descrição curta da ação
  target TEXT,                        -- alvo (arquivo/comando/serviço)
  perm_level INTEGER,                 -- nível de permissão vigente (1..5)
  authorized INTEGER NOT NULL DEFAULT 0, -- 0/1: houve autorização explícita
  level TEXT NOT NULL DEFAULT 'info', -- info|aviso|critico
  detail TEXT,
  result TEXT,                        -- resultado da ação
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON companion_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_project ON companion_audit(user_id, project);
