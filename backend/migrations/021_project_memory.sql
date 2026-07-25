-- Vínculo entre memória, projeto e conversa.
--
-- Causa-raiz que esta migration destrava: os projetos do Modo Desenvolvedor
-- viviam SÓ no localStorage do navegador. O backend nunca soube a que projeto
-- uma conversa pertencia, então o Context Builder não tinha como priorizar
-- "as últimas conversas deste projeto" ao abrir um chat novo — ele só sabia
-- fazer busca semântica global, que traz memórias antigas e genéricas.
--
-- 1) dev_projects: o projeto passa a existir no servidor (nome, descrição,
--    tecnologias, regras e a memória permanente categorizada). O navegador
--    continua sendo a origem da edição; aqui guardamos a cópia que a
--    recuperação de contexto consulta.
-- 2) project_id em conversations / conversation_chunks / memory: o elo que
--    permite recuperar por projeto, e não só por similaridade de texto.

CREATE TABLE IF NOT EXISTS dev_projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  techs        TEXT,
  rules        TEXT,
  memory       TEXT,                  -- JSON: {arquitetura, decisoes, padroes, corrigidos, preferencias, proximos}
  binding      TEXT,                  -- JSON: {type:'none'|'folder'|'github', ...}
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_projects_user ON dev_projects(user_id);

ALTER TABLE conversations       ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE conversation_chunks ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE memory              ADD COLUMN IF NOT EXISTS project_id TEXT;
-- Com review_auto_memory ligado (padrão), o fato aprendido passa pela fila de
-- revisão antes de virar memória — o vínculo do projeto precisa sobreviver a
-- essa escala, senão a memória nasce órfã depois de aprovada.
ALTER TABLE memory_suggestions  ADD COLUMN IF NOT EXISTS project_id TEXT;

-- Recuperar "as últimas N conversas deste projeto" precisa ser barato: o
-- índice composto (projeto, data) serve exatamente essa consulta.
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(user_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_project        ON conversation_chunks(user_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_project        ON memory(user_id, project_id);
