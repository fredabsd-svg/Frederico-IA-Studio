-- Modo Design — imagens geradas por IA dentro do artefato.
--
-- O Modo Design gera HTML/JSON por prompt; até aqui o layout `image-full` dos
-- slides entregava um painel na cor da marca em vez de uma foto, porque o
-- modelo devolve texto, não binário. Esta tabela guarda as imagens geradas
-- pela rota dedicada, para que o artefato possa referenciá-las por URL.
--
-- Decisões de schema:
--
-- 1) `data BYTEA` em vez de gravar em disco. O artefato do Design já é
--    autocontido (HTML único, sem dependências externas); manter a imagem no
--    banco preserva essa propriedade — um backup do banco restaura o projeto
--    inteiro, sem arquivos soltos no filesystem. O teto de 5 MB por imagem e
--    50 MB por projeto impede que um projeto inflável coma o banco.
--
-- 2) `mime` é gravado pelo backend (sempre image/png ou image/jpeg — o que o
--    provedor devolveu), nunca pelo cliente. A rota GET usa-o no Content-Type
--    e ignora qualquer valor enviado pelo usuário.
--
-- 3) `prompt` é guardado para auditoria e para o histórico do chat do projeto
--    (a fala do assistente cita qual imagem foi inserida). Limitado em 1000
--    caracteres — o teto do pedido do Design é 4000, mas o prompt de imagem
--    costuma ser curto.
--
-- 4) `preview_token` é a chave de leitura SEM sessão: o iframe do preview roda
--    em origem opaca e não envia cookie, então a rota GET aceita o token do
--    projeto como alternativa à sessão do dono. Isso é o mesmo padrão do
--    preview do artefato (migration 022).
--
-- 5) `usage_kind = 'design_image'` distingue o consumo das imagens do consumo
--    do texto do Design (`'design'`), para que o teto diário possa ser
--    controlado separadamente no futuro sem migration nova.

CREATE TABLE IF NOT EXISTS design_images (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  prompt          TEXT NOT NULL,
  mime            TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  data            BYTEA NOT NULL,
  model           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_design_images_project ON design_images(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_design_images_user ON design_images(user_id, created_at DESC);
