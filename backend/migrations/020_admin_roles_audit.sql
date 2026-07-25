-- Migration 020 — autorização administrativa PERSISTIDA e trilha de auditoria.
--
-- PROBLEMA CORRIGIDO
-- Até aqui, "ser administrador" era comparar o e-mail da sessão com a variável
-- ADMIN_EMAIL. Como o cadastro por e-mail/senha não exige verificação, qualquer
-- pessoa que se registrasse com aquele endereço ANTES do dono legítimo — ou que
-- tomasse o endereço depois — ganhava poder para baixar o backup completo (banco
-- inteiro + workspaces + chave mestra de todos os usuários), administrar o modo
-- gratuito e alterar a configuração global do Docling. Não havia registro de
-- nenhuma dessas ações.
--
-- MODELO NOVO
-- 1) user_roles é a AUTORIDADE. O papel fica preso ao ID do usuário, não ao
--    texto do e-mail: trocar o endereço de uma conta não transfere o poder, e
--    criar outra conta com o e-mail do administrador não concede nada.
-- 2) ADMIN_EMAIL vira apenas BOOTSTRAP: serve para o PRIMEIRO administrador
--    reivindicar o papel enquanto a tabela ainda não tem nenhum admin. Depois
--    disso, o e-mail sozinho não autoriza mais nada.
-- 3) ADMIN_USER_ID (opcional) fixa o administrador por ID no ambiente — o modo
--    recomendado em instalação pública, porque não depende de e-mail algum.
-- 4) admin_audit registra toda ação administrativa (quem, o quê, quando, de
--    onde), inclusive a própria concessão do papel.
--
-- Compatibilidade: nenhuma linha é criada aqui. Na primeira vez que o titular
-- de ADMIN_EMAIL (ou ADMIN_USER_ID) acessa uma rota administrativa, o papel é
-- concedido e auditado automaticamente — o administrador atual não precisa
-- fazer nada e não perde o acesso.

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  role TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  granted_by TEXT,
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles (role);

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_user ON admin_audit (user_id);
