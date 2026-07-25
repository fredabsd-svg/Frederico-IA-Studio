-- Frederico Companion — assistente virtual (camada de experiência sobre o Studio).
--
-- 1) companion_settings: uma linha POR USUÁRIO com a configuração do Companion
--    (personagem, assistente/persona associado, modelo, modo de comportamento,
--    nível de animação, nível de permissão, voz). Guardado como JSON em `settings`
--    para evoluir o formato sem novas migrations — o mesmo padrão de model_teams.
-- 2) companion_events: o "backbone" de alertas/atividades. Cada evento carrega os
--    campos exigidos pela seção 9 da proposta (origem, data/hora, projeto, nível de
--    importância, dados enviados ao modelo, ação proposta, autorização necessária e
--    resultado da execução) para dar transparência e auditoria ao usuário.

CREATE TABLE IF NOT EXISTS companion_settings (
  user_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companion_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- categoria: erro_recorrente, sem_commit, execucao_presa...
  level TEXT NOT NULL DEFAULT 'info', -- info | aviso | critico
  title TEXT NOT NULL,
  detail TEXT,                        -- explicação legível para o usuário
  origin TEXT,                        -- de onde veio (app, agente_local, github...)
  project TEXT,                       -- projeto/conversa relacionado
  data_sent TEXT,                     -- resumo do que foi/seria enviado a um modelo
  proposed_action TEXT,              -- ação sugerida pelo Companion
  authz TEXT,                         -- nível de autorização necessário ("authorization"
                                      -- é palavra reservada no PostgreSQL, por isso authz)
  result TEXT,                        -- resultado após execução (quando houver)
  status TEXT NOT NULL DEFAULT 'novo',-- novo | visto | dispensado | resolvido
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_companion_events_user ON companion_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_companion_events_status ON companion_events(user_id, status);
