// Núcleo HTTP do backend: middlewares (segurança, autenticação, semeadura) e a
// montagem dos routers de src/routes/*. As rotas em si vivem nos módulos por
// domínio (conversations, memories, tasks...) — ver src/routes/.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { db } from './db.js';
import { maybeReindexOnModelChange, loadSettings } from './memory/memoryService.js';
import { initVectorStore } from './memory/vectorStore.js';
import { ensureUserSeeded } from './seed.js';
import { isConversationId, loadPcFolders } from './sandbox.js';
import { auth, requireAuth } from './auth.js';
import { toNodeHandler } from 'better-auth/node';
import { runMigrations } from './migrate.js';
import { sweepOldConversations, CONVERSATION_RETENTION_DAYS, sweepOldUsage, USAGE_RETENTION_DAYS } from './privacy.js';
import { runDailyCatalogSync } from './catalogSync.js';
import accountRouter from './routes/account.js';
import modelsRouter from './routes/models.js';
import assistantsRouter from './routes/assistants.js';
import pcFoldersRouter from './routes/pcFolders.js';
import inboxRouter from './routes/inbox.js';
import clientsRouter from './routes/clients.js';
import templatesRouter from './routes/templates.js';
import memoriesRouter from './routes/memories.js';
import providerRouter from './routes/provider.js';
import freeTierRouter from './routes/freeTier.js';
import connectorsRouter from './routes/connectors.js';
import analyticsRouter from './routes/analytics.js';
import conversationsRouter from './routes/conversations.js';
import tasksRouter, { processTasks } from './routes/tasks.js';
import schedulesRouter, { startSchedulers } from './routes/schedules.js';
import backupRouter from './routes/backup.js';
import cacheRouter from './routes/cache.js';
import modelTeamsRouter from './routes/modelTeams.js';
import companionRouter from './routes/companion.js';
import doclingRouter from './routes/docling.js';
import { healthMetrics } from './healthMetrics.js';
import { sweepExpiredArtifacts, RETENTION_DAYS as DOCLING_RETENTION_DAYS } from './docling/retention.js';
import { startHealthSampling } from './companion/health.js';

const app = express();
const port = process.env.PORT || 3001;

// Com as rotas agora assíncronas (banco em Postgres), uma rejeição de Promise
// num handler NÃO é encaminhada ao middleware de erro pelo Express 4 — sem isto,
// um erro de query numa rota derrubaria o processo inteiro. Este shim embrulha
// todo handler async para que qualquer rejeição vire um 500 amigável (via next).
// (Os routers de src/routes/* aplicam o mesmo shim via makeRouter().)
for (const method of ['get', 'post', 'put', 'delete', 'patch', 'all']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(h =>
    (typeof h === 'function' && h.length < 4)
      ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
      : h));
}
// Rede de segurança final: se ainda escapar uma rejeição não tratada, registra
// e segue — nunca derruba o servidor por causa de uma requisição.
process.on('unhandledRejection', (err) => {
  healthMetrics.unhandledRejections++;
  console.error('[unhandledRejection]', err);
});

// ---- Cabeçalhos de segurança, CORS e rate limiting HTTP ----
// Atrás de um proxy (Caddy em produção, Vite em dev): confia no PRIMEIRO salto
// para req.ip refletir o cliente real — essencial para o rate limit por IP.
app.set('trust proxy', 1);
// Helmet: X-Frame-Options, nosniff, Referrer-Policy, HSTS etc. A CSP fica
// desligada porque este processo só serve JSON/SSE/downloads — o HTML do app
// vem do Caddy (produção) ou do Vite (dev). COOP também fica desligado: o
// header (same-origin) na página de callback do OAuth do GitHub zeraria o
// window.opener do popup e o postMessage 'fred-github-connected' nunca
// chegaria ao painel — o popup não fecharia nem marcaria "conectado".
app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: false }));
// CORS: em produção o app é servido pela MESMA origem (o Caddy faz proxy de
// /api) e em dev o Vite idem — nenhuma origem externa é liberada por padrão.
// (Antes, sem FRONTEND_URL o fallback era '*': qualquer site podia chamar a
// API. origin:false = sem cabeçalhos CORS = só a própria origem.)
const corsOrigins = [process.env.FRONTEND_URL, process.env.BETTER_AUTH_URL].filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true }));
// Limite geral da API por IP (RATE_API_PER_MIN=0 desliga). Protege uploads,
// listagens e força bruta de rotas — o limite DIÁRIO de mensagens por usuário
// (RATE_MSGS_PER_DAY) continua valendo (ver routes/helpers.js).
const RATE_API_PER_MIN = Math.max(0, Number(process.env.RATE_API_PER_MIN ?? 600));
if (RATE_API_PER_MIN) {
  app.use('/api', rateLimit({
    windowMs: 60_000, limit: RATE_API_PER_MIN, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Muitas requisições. Aguarde um instante e tente de novo.' },
  }));
}
// Login/cadastro: janela própria e bem mais apertada, só para POST (o GET de
// sessão roda a cada carregamento de página e não pode ser freado assim).
const RATE_AUTH_PER_15MIN = Math.max(0, Number(process.env.RATE_AUTH_PER_15MIN ?? 50));
const authLimiter = RATE_AUTH_PER_15MIN
  ? rateLimit({
      windowMs: 15 * 60_000, limit: RATE_AUTH_PER_15MIN, standardHeaders: true, legacyHeaders: false,
      message: { error: 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.' },
    })
  : null;

// ---- Autenticação (Better Auth: e-mail/senha + GitHub + Google) ----
// O handler de /api/auth/* precisa do corpo CRU da requisição, então é montado
// ANTES do express.json (senão o body é consumido e o login trava — armadilha
// clássica). Ele cuida de login, cadastro, OAuth, sessão e logout.
app.all('/api/auth/*', (req, res, next) => (authLimiter && req.method === 'POST') ? authLimiter(req, res, next) : next(), toNodeHandler(auth));

app.use(express.json({ limit: '10mb' }));

// Todas as rotas /api exigem login, exceto a checagem de saúde e o próprio fluxo
// de autenticação. requireAuth coloca o id do usuário logado em req.userId
// (base do isolamento por usuário da Fase 3).
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  return requireAuth(req, res, next);
});

// Depois do portão de autenticação: garante que os padrões (assistentes,
// templates, docpro) existam PARA este usuário antes de qualquer handler. É
// idempotente e barato (Set em memória) após a primeira vez.
app.use('/api', async (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  if (req.userId) { try { await ensureUserSeeded(req.userId); } catch {} }
  next();
});

app.use('/api/conversations/:id', (req, res, next) => {
  if (!isConversationId(req.params.id)) return res.status(400).json({ error: 'Identificador de conversa inválido.' });
  next();
});

// ---- Rotas da API, modularizadas por domínio (src/routes/*) ----
app.use('/api', accountRouter);
app.use('/api', modelsRouter);
app.use('/api', assistantsRouter);
app.use('/api', pcFoldersRouter);
app.use('/api', inboxRouter);
app.use('/api', clientsRouter);
app.use('/api', templatesRouter);
app.use('/api', memoriesRouter);
app.use('/api', providerRouter);
app.use('/api', freeTierRouter);
app.use('/api', connectorsRouter);
app.use('/api', analyticsRouter);
app.use('/api', conversationsRouter);
app.use('/api', tasksRouter);
app.use('/api', schedulesRouter);
app.use('/api', backupRouter);
app.use('/api', cacheRouter);
app.use('/api', modelTeamsRouter);
app.use('/api', companionRouter);
app.use('/api', doclingRouter);

// LGPD — retenção automática: com CONVERSATION_RETENTION_DAYS > 0, apaga
// conversas paradas há mais de N dias (varredura a cada 6 h; desligada por padrão).
if (CONVERSATION_RETENTION_DAYS > 0) {
  setInterval(() => sweepOldConversations().catch(e => console.error('[retenção]', e.message)), 6 * 60 * 60 * 1000).unref();
  setTimeout(() => sweepOldConversations().catch(e => console.error('[retenção]', e.message)), 60 * 1000).unref();
}
// Retenção da tabela de consumo de tokens (usage/usage_daily): sem isto ela
// cresce para sempre. Padrão: 365 dias (USAGE_RETENTION_DAYS=0 desliga).
if (USAGE_RETENTION_DAYS > 0) {
  setInterval(() => sweepOldUsage().catch(e => console.error('[retenção-uso]', e.message)), 24 * 60 * 60 * 1000).unref();
  setTimeout(() => sweepOldUsage().catch(e => console.error('[retenção-uso]', e.message)), 90 * 1000).unref();
}
// Retenção dos artefatos DERIVADOS do Docling (JSON/Markdown/chunks/figuras).
// Só os derivados (reprocessáveis) — nunca os arquivos originais do usuário.
// DOCLING_RETENTION_DAYS=0 (padrão) desliga.
if (DOCLING_RETENTION_DAYS > 0) {
  setInterval(() => sweepExpiredArtifacts().catch(e => console.error('[docling-retenção]', e.message)), 24 * 60 * 60 * 1000).unref();
  setTimeout(() => sweepExpiredArtifacts().catch(e => console.error('[docling-retenção]', e.message)), 120 * 1000).unref();
}

// Catálogo de modelos: sincronização automática pelo menos 1x/dia (checa modelos
// novos/removidos, preço, contexto, capacidades, status; registra o histórico).
// Não faz chamadas pagas de chat. MODEL_CATALOG_SYNC=0 desliga.
if (process.env.MODEL_CATALOG_SYNC !== '0') {
  setInterval(() => runDailyCatalogSync().catch(e => console.error('[catálogo]', e.message)), 24 * 60 * 60 * 1000).unref();
  setTimeout(() => runDailyCatalogSync().catch(e => console.error('[catálogo]', e.message)), 5 * 60 * 1000).unref();
}

// 404 padrão para rotas de API desconhecidas
app.use('/api', (_, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Tratador global de erros: loga o detalhe no servidor e devolve mensagem
// limpa ao cliente (sem stack trace).
app.use((err, req, res, _next) => {
  console.error('[erro]', req.method, req.path, err);
  if (res.headersSent) return res.end();
  const status = err.type === 'entity.parse.failed' ? 400 : err.status || 500;
  res.status(status).json({ error: status === 400 ? 'Requisição inválida (JSON malformado).' : 'Erro interno do servidor.' });
});

(async () => {
  // 1) Migrations criam/atualizam o schema ANTES de qualquer query.
  await runMigrations();
  // 1b) pgvector: habilita a busca vetorial no banco quando a extensão existir
  //     (senão a busca semântica continua no fallback em JS, como antes).
  await initVectorStore();
  // 2) Aquece os caches em memória (settings e pastas do PC).
  await loadSettings();
  await loadPcFolders();
  try { await maybeReindexOnModelChange(); } catch {}
  // 3) Os seeds agora são POR USUÁRIO (ensureUserSeeded), disparados sob demanda
  //    pelo middleware após a autenticação — não há mais seed global no boot.
  // 4) Tarefas que estavam "rodando" quando o servidor caiu voltam para a fila.
  try { await db.prepare("UPDATE tasks SET status='queued', progress_text='Reenfileirada após reinício' WHERE status='running'").run(); } catch {}
  // 5) Sobe o servidor, arma as rotinas agendadas e dispara o worker de tarefas.
  app.listen(port, () => console.log(`Frederico AI Studio backend em http://localhost:${port}`));
  startSchedulers();
  startHealthSampling(); // amostragem de saúde (memória/CPU) para o copiloto
  setTimeout(() => processTasks().catch(() => {}), 2000);
})().catch((e) => { console.error('Falha no boot do backend:', e); process.exit(1); });
