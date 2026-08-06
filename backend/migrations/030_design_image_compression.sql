-- Modo Design — auditoria da compressão automática de imagens.
--
-- A Frente 13 adiciona compressão transparente no momento da geração: se a
-- imagem devolvida pelo provedor é grande (> 1 MB), é re-encodada em JPEG/WebP
-- antes de ser gravada. A versão ORIGINAL é preservada por 30 dias para
-- auditoria — depois disso um purge no /api/admin/purge-stale-image-originals
-- (chamado pelo cron diário) remove a coluna `original_data`.
--
-- Decisões de schema:
--
-- 1) Colunas ADITIVAS, todas NULLABLE: uma linha criada antes desta migração
--    continua válida — a coluna `compressed_at` simplesmente fica NULL, e o
--    código trata NULL como "não comprimido".
--
-- 2) `original_*` carrega a versão que o provedor devolveu; `mime`, `byte_size`
--    e `data` carregam a versão servida ao `<img>`. Quando `original_data` é
--    NULL, os dois são iguais (compressão não valeu a pena).
--
-- 3) `compressed_at` separa o "foi comprimido nesta data" do `created_at` (data
--    da geração). Se um dia a compressão mudar de heurística, dá pra reprocessar
--    as linhas com `original_data IS NOT NULL AND compressed_at < ?`.
--
-- 4) O índice em `compressed_at` é parcial (só linhas com original preservado):
--    fica barato mesmo com milhões de imagens, e o query do purge é rápido.

ALTER TABLE design_images
  ADD COLUMN IF NOT EXISTS original_mime   TEXT,
  ADD COLUMN IF NOT EXISTS original_size   INTEGER,
  ADD COLUMN IF NOT EXISTS original_data   BYTEA,
  ADD COLUMN IF NOT EXISTS compressed_at   TEXT;

CREATE INDEX IF NOT EXISTS idx_design_images_original_kept
  ON design_images(compressed_at)
  WHERE original_data IS NOT NULL;