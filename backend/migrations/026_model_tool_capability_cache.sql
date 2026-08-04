-- Cache persistido de capacidade de modelos (F-24).
--
-- `markModelCapabilityUnsupported` em modelCapabilities.js atualiza um Map em
-- memória. O problema: o cache se perde no reinício. Resultado prático: um
-- modelo que falhou com "no endpoints found that support tool use" ontem, volta
-- HOJE como apto para ferramentas, recebe a subtarefa, falha de novo, e o
-- usuário paga o ciclo.
--
-- Esta tabela guarda a decisão por (provider, model). Antes de tentar uma
-- chamada de ferramenta com um modelo desconhecido, o backend consulta a tabela;
-- se ela disser "não suporta", pula o modelo sem gastar a chamada.
--
-- Apenas `tools` está aqui por enquanto — é a única capacidade que afeta
-- diretamente o caminho do sub-agente (F-24). Quando outras capacidades
-- precisarem persistir, é só adicionar colunas ou criar uma tabela por
-- capacidade.

CREATE TABLE IF NOT EXISTS model_tool_capability_cache (
  provider_id       TEXT NOT NULL,       -- ex.: "prov_abc123"
  model             TEXT NOT NULL,       -- ex.: "deepseek-chat" ou "openai/gpt-4o-mini"
  supports_tools    INTEGER NOT NULL,    -- 1 = sim, 0 = não
  last_attempt_at   TEXT,                -- última vez que tentamos usar este (provedor, modelo) com tools
  last_error        TEXT,                -- mensagem truncada do provedor (ex.: "No endpoints found that support tool use")
  attempts          INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (provider_id, model)
);

CREATE INDEX IF NOT EXISTS idx_model_tool_capability_unsupported
  ON model_tool_capability_cache(supports_tools, last_attempt_at);
