-- Copiloto — contexto autorizado, memória própria e preferências.
--
-- O copiloto (Nino) nasceu 100% isolado: nada do chat principal entra no painel
-- dele. Esse isolamento continua sendo o PADRÃO, mas ele custava caro no uso
-- diário — o usuário tinha de copiar e colar o contexto toda vez. Estas tabelas
-- sustentam três coisas que o usuário passa a AUTORIZAR explicitamente:
--
-- 1) copilot_prefs: as preferências do painel — se o copiloto pode ler o trecho
--    recente do chat principal (nunca | perguntar | sempre), quantas mensagens,
--    estilo e tom das respostas, e se usa a memória e a base do Studio. O
--    padrão é "perguntar": nenhuma leitura acontece sem um pedido explícito na
--    interface, mensagem a mensagem.
-- 2) copilot_notes: a memória própria do copiloto — preferências, temas em
--    andamento e lembretes que sobrevivem entre conversas. É de escrita
--    controlada pelo usuário (ele cria, fixa e apaga); o copiloto só lê.
--
-- Toda leitura do chat principal fica registrada em companion_audit (categoria
-- "ler"), então autorizar não significa perder rastro do que foi lido.

CREATE TABLE IF NOT EXISTS copilot_prefs (
  user_id    TEXT PRIMARY KEY,
  prefs      TEXT NOT NULL,          -- JSON sanitizado por copilot/core.js
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS copilot_notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'preferencia', -- preferencia | tema | lembrete | fato
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'manual',      -- manual | copiloto
  pinned     INTEGER NOT NULL DEFAULT 0,          -- fixada: entra sempre no contexto
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A consulta quente é "as notas deste usuário, fixadas primeiro, mais recentes
-- antes" — montada a cada mensagem do copiloto.
CREATE INDEX IF NOT EXISTS idx_copilot_notes_user ON copilot_notes(user_id, pinned DESC, updated_at DESC);
