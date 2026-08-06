-- Migration 031 — adicionar `feature` e `cost_usd` em `usage`.
--
-- Por que: o painel admin precisa agregar consumo POR FEATURE (chat, design,
-- design-image, scheduled-task, multimodel). Até aqui só tínhamos `kind`
-- (chat/orquestrador/tarefa/design/design_image/multimodelo), que mistura
-- "tipo de cobrança" com "tipo de uso" e tem rótulos diferentes entre arquivos
-- (`'design'` vs `'design_image'`, `'tarefa'` vs `'scheduled-task'`).
--
-- `feature` é um rótulo ESTÁVEL e PADRONIZADO — uma das strings:
--   * 'chat'               — conversa normal (com ou sem assistente)
--   * 'multimodel'         — pipeline MultiModelBoard
--   * 'design'             — geração de HTML/JSON do artefato
--   * 'design-image'       — imagem gerada por IA dentro do artefato
--   * 'scheduled-task'     — tarefa agendada
--
-- Linhas antigas (sem `feature`) ficam NULL — o dashboard trata NULL como
-- "anterior à instrumentação" e as exclui das agregações por feature. Isso
-- evita misturar dados novos com classificação indefinida.
--
-- `cost_usd` é o custo estimado em dólares (NUMERIC para evitar float drift).
-- NULL significa "preço do modelo desconhecido" — entra na contagem de volume
-- mas NÃO entra na soma de custo. O dashboard mostra os dois separadamente
-- ("gastei $X em Y requests de Z modelos conhecidos").
--
-- Decisões:
--   * Colunas aditivas (IF NOT EXISTS) — não quebra linhas existentes.
--   * `cost_usd NUMERIC(10,6)` — USD com até 6 casas (suficiente para $/token
--     sem arredondar a zero).
--   * Índice em `feature` para a agregação `GROUP BY feature WHERE created_at
--     > ?`. Mais útil que índice composto enquanto o volume não explodir.
ALTER TABLE usage ADD COLUMN IF NOT EXISTS feature TEXT;
ALTER TABLE usage ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6);

CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage(feature);
CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage(created_at);