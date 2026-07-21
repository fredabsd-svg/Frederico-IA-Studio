-- Checkpoint de execução: retomada REAL de uma tarefa interrompida.
--
-- Motivação: quando um run batia no limite de ciclos (ou o provedor caía / o
-- watchdog abortava um stream travado), o app dizia "Reenviar para continuar de
-- onde parei" — mas o "Reenviar" TRUNCAVA a resposta parcial e começava um run
-- NOVO do zero. Todo o estado operacional (array de mensagens do agente: objetivo,
-- plano, tool_calls já feitas, resultados, erros, texto parcial, decisões) vivia
-- só na RAM e era perdido. Esta tabela persiste esse estado para que a retomada
-- carregue o mesmo ponto e prossiga da próxima etapa pendente.
--
-- Um checkpoint por conversa (a unidade de retomada). Persistente no Postgres,
-- então sobrevive a um REINÍCIO do backend (não é só memória RAM). ON DELETE
-- CASCADE: apagar a conversa limpa o checkpoint junto.

CREATE TABLE IF NOT EXISTS execution_checkpoints (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,           -- identifica a execução que gerou o checkpoint
  objective       TEXT,                    -- o pedido original do usuário (userText)
  reason          TEXT,                    -- 'step_limit' | 'provider_failure' | 'stalled' | 'stopped'
  model           TEXT,                    -- modelo ativo no momento da interrupção
  tried_models    JSONB,                   -- cadeia de failover já tentada (não reinicia no resume)
  step            INTEGER,                 -- ciclo em que parou
  messages        JSONB NOT NULL,          -- O CHECKPOINT: array de mensagens do agente (estado completo)
  usage           JSONB,                   -- tokens acumulados até aqui
  meta            JSONB,                   -- webSearch, effort, developer, assistantId (para recompor o run)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exec_checkpoints_user ON execution_checkpoints(user_id);
