// Autenticação multi-usuário com Better Auth: e-mail/senha + GitHub + Google.
// Substitui a antiga proteção por senha única (APP_PASSWORD). Usa o MESMO
// PostgreSQL do app (Pool próprio para as tabelas user/session/account/verification).
//
// Variáveis de ambiente (ver .env.example):
//   BETTER_AUTH_SECRET   segredo (>=32 chars) — `openssl rand -hex 32`
//   BETTER_AUTH_URL      origem pública do app (dev: http://localhost:5173)
//   FRONTEND_URL         origem do frontend (mesma, em dev)
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   DATABASE_URL         conexão Postgres (mesma do app)
import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import pg from 'pg';

const { Pool } = pg;

// Só registra os provedores sociais com credenciais preenchidas no .env.
// Sem isso, um clique em "Continuar com Google/GitHub" num servidor sem as
// credenciais devolvia 500 — os botões devem nem aparecer nesse caso
// (o frontend consulta a lista via /api/health → socialProviders).
const socialProviders = {};
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  socialProviders.github = {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  };
}
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
}
export const enabledSocialProviders = Object.keys(socialProviders);

export const auth = betterAuth({
  database: new Pool({
    connectionString:
      process.env.DATABASE_URL || 'postgres://studio:studio@localhost:5432/studio',
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  // Origem pública onde o app é acessado: o navegador fala com /api/auth aqui e
  // o Vite repassa ao backend. É a base dos callbacks OAuth registrados no
  // GitHub/Google. Em produção, troque por https://SEU_DOMINIO no .env.
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:5173',
  emailAndPassword: { enabled: true },
  socialProviders,
  trustedOrigins: [process.env.FRONTEND_URL, process.env.BETTER_AUTH_URL].filter(Boolean),
});

// Middleware: exige uma sessão válida. Aplicado a todas as rotas /api exceto
// /api/health e /api/auth/*. Coloca o id do usuário logado em req.userId
// (usado na Fase 3 para o isolamento de dados por usuário).
export async function requireAuth(req, res, next) {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return res.status(401).json({ error: 'Não autenticado. Faça login para continuar.' });
    req.userId = session.user.id;
    req.user = session.user;
    next();
  } catch {
    return res.status(401).json({ error: 'Não autenticado. Faça login para continuar.' });
  }
}
