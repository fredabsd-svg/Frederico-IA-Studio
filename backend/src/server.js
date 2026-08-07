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
import { isConversationId, loadPcFolders, migrateLegacyWorkspaces, startSandboxReconciliation } from './sandbox.js';
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
import devProjectsRouter from './routes/devProjects.js';
import tasksRouter, { processTasks } from './routes/tasks.js';
import schedulesRouter, { startSchedulers } from './routes/schedules.js';
import backupRouter from './routes/backup.js';
import cacheRouter from './routes/cache.js';
import modelTeamsRouter from './routes/modelTeams.js';
import companionRouter from './routes/companion.js';
import copilotRouter from './routes/copilot.js';
import doclingRouter from './routes/docling.js';
import designRouter from './routes/design.js';
import designAdminRouter from './routes/designAdmin.js';
import usageDashboardRouter from './routes/usageDashboard.js';
import toolProbeRouter from './routes/toolProbe.js';
import { healthMetrics } from './healthMetrics.js';
import { sweepStaleUploadTemps } from './uploads.js';
import { sweepStalePipelineRuns } from './agent/pipelineRuns.js';
import { sweepOrphanAgentRuns } from './agent/runLog.js';
import { sweepExpiredArtifacts, RETENTION_DAYS as DOCLING_RETENTION_DAYS } from './docling/retention.js';
import { isDoclingEnabled } from './docling/config.js';
import { doclingHealth } from './docling/runner.js';
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
// Rotas de API que NÃO exigem sessão:
//   * `/health` — checagem de saúde;
//   * `/auth/*` — fluxo de autenticação;
//   * `/design/preview/:token` — prévia do Modo Design (HTML gerado por IA,
//     código não confiável, servido a partir de um token aleatório de 32
//     caracteres; existe justamente para poder ser servida de outra origem
//     sem que o navegador envie o cookie do app);
//   * `/design/images/:id` — imagens geradas para o artefato. O iframe do
//     preview roda em origem opaca e não envia cookie, então a autorização
//     aqui é o token de preview do projeto passado por query string (validado
//     em design/images.js). Ver docs/DESIGN_STUDIO.md §Imagens no artefato.
const isPublicApiPath = (path) => path === '/health'
  || path.startsWith('/auth')
  || path.startsWith('/design/preview/')
  || path.startsWith('/design/images/');

app.use('/api', (req, res, next) => {
  if (isPublicApiPath(req.path)) return next();
  return requireAuth(req, res, next);
});

// Depois do portão de autenticação: garante que os padrões (assistentes,
// templates, docpro) existam PARA este usuário antes de qualquer handler. É
// idempotente e barato (Set em memória) após a primeira vez.
app.use('/api', async (req, res, next) => {
  if (isPublicApiPath(req.path)) return next();
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
app.use('/api', devProjectsRouter);
app.use('/api', tasksRouter);
app.use('/api', schedulesRouter);
app.use('/api', backupRouter);
app.use('/api', cacheRouter);
app.use('/api', modelTeamsRouter);
app.use('/api', companionRouter);
app.use('/api', copilotRouter);
app.use('/api', doclingRouter);
app.use('/api', designRouter);
app.use('/api', designAdminRouter);
app.use('/api', usageDashboardRouter);
app.use('/api', toolProbeRouter);

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

// Diagnóstico de boot da camada documental. A flag do backend
// (DOCLING_ENABLED) e o serviço (perfil `docling` do compose) são ligados
// separadamente — quando divergem, o sintoma aparecia só documento a documento.
async function warnIfDoclingUnavailable() {
  if (!isDoclingEnabled()) return;
  if (!process.env.DOCLING_INTERNAL_TOKEN) {
    console.warn('[docling] AVISO: DOCLING_INTERNAL_TOKEN vazio — o serviço aceita requisições sem autenticação de qualquer container da mesma rede Docker. Defina um valor no .env.');
  }
  const health = await doclingHealth();
  if (health.ok) {
    console.log(`[docling] serviço disponível (modelos carregados: ${health.models_loaded ? 'sim' : 'ainda não'}).`);
    return;
  }
  console.error(`[docling] ERRO: DOCLING_ENABLED=true, mas o serviço em ${process.env.DOCLING_SERVICE_URL || 'http://docling-service:8000'} não respondeu (${health.error || `HTTP ${health.status}`}).`);
  console.error('[docling] Sem ele, TODO documento enviado vai falhar. Suba o serviço com: docker compose --profile docling up -d --build');
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
  // 2b) Layout do workspace por USUÁRIO (workspaces/users/<usuário>/<conversa>):
  //     move as pastas legadas (workspaces/<conversa>) para o dono correto.
  //     Idempotente — nada acontece depois da primeira execução.
  try { await migrateLegacyWorkspaces(); } catch (e) { console.error('[workspace]', e.message); }
  try { await maybeReindexOnModelChange(); } catch {}
  // 3) Os seeds agora são POR USUÁRIO (ensureUserSeeded), disparados sob demanda
  //    pelo middleware após a autenticação — não há mais seed global no boot.
  // 4) Tarefas que estavam "rodando" quando o servidor caiu voltam para a fila.
  try { await db.prepare("UPDATE tasks SET status='queued', progress_text='Reenfileirada após reinício' WHERE status='running'").run(); } catch {}
  // 4b) Docling ligado: confere no boot se o serviço realmente responde.
  //     Sem esta checagem, DOCLING_ENABLED=true sem o serviço no ar (é preciso
  //     subir com `--profile docling`) fazia CADA documento falhar sozinho, em
  //     silêncio, sem nada indicar a causa nos logs do backend.
  await warnIfDoclingUnavailable();
  // 5) Sobe o servidor, arma as rotinas agendadas e dispara o worker de tarefas.
  app.listen(port, () => console.log(`Frederico AI Studio backend em http://localhost:${port}`));
  // 5b) Containers órfãos: tudo que sobrou de um processo anterior (queda do
  //     backend/host) é removido agora, e uma varredura periódica recolhe o que
  //     escapar do mapa em memória. Só toca em containers com a label do app.
  startSandboxReconciliation();
  // Temporários de upload abandonados (queda do processo no meio de um envio):
  // varredura no boot e a cada hora. O staging normal já é removido no finally
  // de cada rota — isto é a rede de segurança.
  sweepStaleUploadTemps();
  setInterval(() => { try { sweepStaleUploadTemps(); } catch {} }, 60 * 60 * 1000).unref();
  // Runs do agente órfãos (ADR 0002): um run sem ended_at após o restart morreu
  // com o processo — é marcado como recoverable_error para a UI dizer a verdade
  // ("o servidor reiniciou") em vez de exibir uma execução rodando para sempre.
  try { await sweepOrphanAgentRuns(); } catch (e) { console.error('[run-log]', e.message); }
  // Pipeline runs órfãos (kill-9 no backend): completa como erro e a limpeza
  // periódica remove os terminais antigos (mesma janela de carência do liveStream).
  sweepStalePipelineRuns();
  setInterval(() => { try { sweepStalePipelineRuns(); } catch {} }, 60 * 60 * 1000).unref();
  startSchedulers();
  startHealthSampling(); // amostragem de saúde (memória/CPU) para o copiloto
  setTimeout(() => processTasks().catch(() => {}), 2000);
})().catch((e) => { console.error('Falha no boot do backend:', e); process.exit(1); });
