-- Projetos do Modo Desenvolvedor: o servidor vira a FONTE DE VERDADE (ADR 0004).
--
-- Desde a migration 021 o servidor guardava uma CÓPIA de leitura dos projetos
-- (para o Context Builder); a origem continuava no localStorage do navegador —
-- o risco R7 da auditoria do Developer Workspace 3.0: trocar de navegador ou
-- limpar dados perdia o vínculo repo/branch, as permissões concedidas e a
-- memória do projeto ("o agente passava a dizer que não encontra o
-- repositório").
--
-- Faltavam duas colunas para a linha do servidor carregar o projeto INTEIRO:
--   * permissions — autorização de publicação (githubWrite*) e de comandos
--     (commandGrants). Continua sendo REGISTRO da decisão do usuário: o
--     backend re-valida tudo no uso (githubAccess.js / permissionPolicy.js);
--   * mode — o modo de trabalho padrão do projeto (ask/plan/build/fix/review/auto).
--
-- A lista de conversas do projeto NÃO vira coluna: deriva de
-- conversations.project_id (021), que já é mantida pelo backend.

ALTER TABLE dev_projects ADD COLUMN IF NOT EXISTS permissions TEXT;  -- JSON
ALTER TABLE dev_projects ADD COLUMN IF NOT EXISTS mode TEXT;
