-- Modo Design — projetos visuais gerados e refinados por conversa.
--
-- O Modo Design é um espaço PRÓPRIO: o usuário descreve o que precisa (site,
-- apresentação ou documento visual) e a IA devolve um artefato renderizável.
-- Cada pedido de mudança não sobrescreve o anterior — vira uma VERSÃO nova, o
-- que torna "voltar para a versão anterior" uma consulta, e não um desfazer
-- improvisado no navegador.
--
-- Três decisões de schema que valem a explicação:
--
-- 1) Ids TEXT (nanoid) e datas TEXT ISO-8601, como no resto do app. A proposta
--    original do pedido usava INTEGER AUTOINCREMENT/DATETIME (herança de
--    SQLite); aqui o banco é PostgreSQL e todas as tabelas de domínio já usam
--    `id TEXT PRIMARY KEY` + `created_at TEXT`. Divergir só nesta área tornaria
--    o código de junção e serialização inconsistente com todo o resto.
--
-- 2) `preview_token` é uma CAPACIDADE, não um identificador. O HTML gerado pela
--    IA é código não confiável e precisa rodar num documento de origem opaca
--    (ver docs/DESIGN_STUDIO.md §Segurança). A rota que serve o preview não lê
--    sessão nenhuma: ela confia apenas no token, justamente para que possa ser
--    servida de OUTRA origem (DESIGN_PREVIEW_ORIGIN) sem que o navegador tenha
--    qualquer motivo para enviar o cookie de sessão até lá. Quem tem o token vê
--    o preview — por isso ele é aleatório, longo e regenerável.
--
-- 3) `current_version_id` é redundante com "o maior version_number", mas evita
--    um MAX() por projeto em toda listagem e, principalmente, permite que
--    "reverter" seja um ponteiro movido (a versão antiga continua no histórico)
--    em vez de apagar o que veio depois.

CREATE TABLE IF NOT EXISTS design_systems (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  primary_color   TEXT,
  secondary_color TEXT,
  font_heading    TEXT,
  font_body       TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_design_systems_user ON design_systems(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS design_projects (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  -- web = página/protótipo HTML; slides = apresentação; document = documento
  -- visual (capa, hierarquia tipográfica, tabelas) paginado para impressão.
  output_type      TEXT NOT NULL,
  design_system_id TEXT REFERENCES design_systems(id) ON DELETE SET NULL,
  -- Capacidade de leitura do preview (ver nota 2 no topo).
  preview_token    TEXT NOT NULL UNIQUE,
  current_version_id TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CONSTRAINT design_projects_output_type_ck CHECK (output_type IN ('web','slides','document'))
);

CREATE INDEX IF NOT EXISTS idx_design_projects_user ON design_projects(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS design_versions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  -- Redundante com o projeto, mas o isolamento por usuário do app é sempre
  -- verificado na própria linha consultada — nunca só por junção.
  user_id        TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  content        TEXT NOT NULL,
  prompt_used    TEXT,
  created_at     TEXT NOT NULL,
  CONSTRAINT design_versions_unique_number UNIQUE (project_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_design_versions_project ON design_versions(project_id, version_number DESC);

-- Chat de refinamento do projeto. Fica FORA de `conversations` de propósito: a
-- conversa principal carrega memória semântica, anexos, sandbox e execução de
-- ferramentas — nada disso se aplica aqui, e misturar faria o histórico de
-- design aparecer na barra lateral do chat como se fosse um atendimento.
CREATE TABLE IF NOT EXISTS design_messages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES design_projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  -- Versão que ESTA mensagem produziu (nulo nas falas do usuário e quando a
  -- geração falhou) — é o que liga a bolha do chat ao botão "ver esta versão".
  version_id TEXT,
  created_at TEXT NOT NULL,
  CONSTRAINT design_messages_role_ck CHECK (role IN ('user','assistant'))
);

CREATE INDEX IF NOT EXISTS idx_design_messages_project ON design_messages(project_id, created_at ASC);
