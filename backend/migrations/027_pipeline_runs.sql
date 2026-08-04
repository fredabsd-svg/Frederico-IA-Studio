-- Coordenador durável de pipelines multimodelo (F-15).
--
-- O `runMultiModel` opera em estágios sequenciais (especialistas em modo
-- `pipeline`) ou em rounds paralelos (compare/council/debate). Sem esta tabela,
-- um kill-9 ou restart do backend no meio de uma execução descarta o progresso
-- dos estágios anteriores — o usuário tem de REENVIAR o pedido e refazer
-- todo o trabalho (cada chamada de modelo custa tokens e segundos).
--
-- Cada linha é UM run em andamento. A linha é gravada na entrada do
-- runMultiModel e atualizada a cada fronteira de estágio/round. O array
-- `state_json` guarda o estado serializável (config + resultados parciais
-- + artefatos). A `current_stage` diz de onde retomar; o runMultiModel
-- detecta `current_stage > 0` no boot e pula direto para lá.
--
-- Quando o run termina (done/error/stopped), a linha é preservada por uma
-- janela de carência (GRACE_MS) — mesmo padrão dos checkpoints de execução
-- — para que uma reconexão SSE ainda veja o resultado final. Depois, é
-- removida por um sweeper.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  pipeline_run_id  TEXT PRIMARY KEY,        -- ex.: "pipe_<nanoid>"
  conversation_id  TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  mode             TEXT NOT NULL,           -- compare | council | debate | pipeline
  status           TEXT NOT NULL DEFAULT 'running', -- running | done | stopped | error
  current_stage    INTEGER NOT NULL DEFAULT 0,
  total_stages     INTEGER NOT NULL,
  rounds_run       INTEGER NOT NULL DEFAULT 1,
  config_json      TEXT NOT NULL,           -- a configuração multimodelo validada
  state_json       TEXT NOT NULL DEFAULT '{}', -- resultados parciais, artefatos
  started_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_conversation
  ON pipeline_runs(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user
  ON pipeline_runs(user_id, status);

-- Apenas um run ativo por conversa: um segundo POST /chat em multimodelo
-- na mesma conversa, antes do anterior terminar, é barrado pelo
-- isConversationActive (independente desta tabela); esta UNIQUE é só
-- defesa em profundidade caso duas instâncias do backend tentem inserir
-- a mesma linha em uma race.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pipeline_runs_active
  ON pipeline_runs(conversation_id)
  WHERE status = 'running';
