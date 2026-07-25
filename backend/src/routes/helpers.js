// Utilitários COMPARTILHADOS pelos routers (movidos do server.js na
// modularização — mesma lógica, mesmo comportamento).
import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { workspaceFor } from '../sandbox.js';
import { resolveScheduleTimeZone, scheduleDateKey } from '../scheduling.js';
import { scanUploadBatch } from '../clamav.js';

// Router com o mesmo "shim" async do app: com as rotas assíncronas (Postgres),
// uma rejeição de Promise num handler NÃO é encaminhada ao middleware de erro
// pelo Express 4 — sem isto, um erro de query derrubaria o processo inteiro.
export function makeRouter() {
  const router = Router();
  for (const method of ['get', 'post', 'put', 'delete', 'patch', 'all', 'use']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map(h =>
      (typeof h === 'function' && h.length < 4)
        ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
        : h));
  }
  return router;
}

// Fuso horário das rotinas e dos contadores diários (APP_TIMEZONE).
export const scheduleTimeZone = resolveScheduleTimeZone(process.env.APP_TIMEZONE);

// ---- Autorização administrativa (ver migrations/020_admin_roles_audit.sql) --
// A AUTORIDADE é a tabela user_roles, presa ao ID do usuário. ADMIN_EMAIL é
// apenas bootstrap do PRIMEIRO administrador; ADMIN_USER_ID fixa por id (modo
// recomendado numa instalação pública). Sem nenhum dos dois, NINGUÉM é
// administrador (padrão seguro, como antes).
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_USER_ID = String(process.env.ADMIN_USER_ID || '').trim();
// Exigir e-mail verificado no bootstrap. Fica desligado por padrão porque o
// cadastro por e-mail/senha desta instalação não envia verificação — ligar sem
// um provedor de e-mail configurado deixaria o app sem administrador algum.
const ADMIN_REQUIRE_VERIFIED_EMAIL = process.env.ADMIN_REQUIRE_VERIFIED_EMAIL === 'true';

async function grantAdminRole(userId, grantedBy) {
  await db.prepare(
    `INSERT INTO user_roles (user_id, role, granted_at, granted_by) VALUES (?, 'admin', ?, ?)
     ON CONFLICT (user_id, role) DO NOTHING`
  ).run(userId, now(), grantedBy);
  console.warn(`[admin] papel de administrador concedido ao usuário ${userId} (origem: ${grantedBy}).`);
}

async function resolveAdmin(req) {
  const userId = String(req.userId || '');
  if (!userId) return false;
  // 1) Papel já persistido: manda em tudo.
  const row = await db.prepare("SELECT 1 FROM user_roles WHERE user_id=? AND role='admin'").get(userId);
  if (row) return true;
  // 2) Administrador fixado por ID no ambiente.
  if (ADMIN_USER_ID && userId === ADMIN_USER_ID) {
    await grantAdminRole(userId, 'env:ADMIN_USER_ID');
    await recordAdminAction(req, 'admin.role.granted', { origem: 'ADMIN_USER_ID' });
    return true;
  }
  // 3) Bootstrap por e-mail — vale UMA vez, enquanto não existe nenhum admin.
  //    Depois disso o texto do e-mail deixa de autorizar qualquer coisa: quem
  //    registrar uma conta com o endereço do administrador não herda o poder.
  if (!ADMIN_EMAIL) return false;
  const email = String(req.user?.email || '').trim().toLowerCase();
  if (!email || email !== ADMIN_EMAIL) return false;
  if (ADMIN_REQUIRE_VERIFIED_EMAIL && !req.user?.emailVerified) {
    console.warn('[admin] bootstrap recusado: ADMIN_REQUIRE_VERIFIED_EMAIL=true e o e-mail da conta não está verificado.');
    return false;
  }
  const existing = await db.prepare("SELECT user_id FROM user_roles WHERE role='admin' LIMIT 1").get();
  if (existing) {
    console.warn(`[admin] bootstrap por ADMIN_EMAIL recusado: já existe administrador (${existing.user_id}). Conceda o papel em user_roles se a troca for intencional.`);
    return false;
  }
  await grantAdminRole(userId, 'bootstrap:ADMIN_EMAIL');
  await recordAdminAction(req, 'admin.role.granted', { origem: 'ADMIN_EMAIL', verificado: !!req.user?.emailVerified });
  return true;
}

// Memoiza por requisição (várias rotas consultam isso no mesmo handler).
export async function isAdmin(req) {
  if (req._adminResolved !== undefined) return req._adminResolved;
  let result = false;
  try { result = await resolveAdmin(req); }
  catch (e) {
    // Falha de banco NUNCA vira "é admin": negar é o lado seguro do erro.
    console.error('[admin] falha ao resolver o papel administrativo:', e.message);
    result = false;
  }
  req._adminResolved = result;
  return result;
}

// Portão para rotas administrativas: responde 403 e devolve false quando não é.
export async function requireAdmin(req, res, message = 'Esta ação é restrita ao administrador do sistema.') {
  if (await isAdmin(req)) return true;
  await recordAdminAction(req, 'admin.denied', { rota: req.originalUrl || req.path });
  res.status(403).json({ error: message });
  return false;
}

// Trilha de auditoria das ações administrativas. Nunca lança (uma falha de
// auditoria não pode derrubar a ação) e nunca grava segredo — só metadados.
export async function recordAdminAction(req, action, detail = null) {
  try {
    await db.prepare('INSERT INTO admin_audit (id,user_id,email,action,detail,ip,user_agent,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      nanoid(),
      req?.userId || null,
      req?.user?.email ? String(req.user.email).slice(0, 200) : null,
      String(action).slice(0, 100),
      detail ? JSON.stringify(detail).slice(0, 2000) : null,
      req?.ip ? String(req.ip).slice(0, 100) : null,
      req?.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : null,
      now()
    );
  } catch (e) {
    console.error('[admin-audit] falha ao registrar a ação:', e.message);
  }
}

// "Pastas do PC": monta caminhos do HOST no sandbox. Faz sentido apenas numa
// instalação PESSOAL (local). Numa VPS pública é perigoso, então fica DESLIGADO
// por padrão — habilite com ENABLE_PC_FOLDERS=true só em uso pessoal confiável.
export const PC_FOLDERS_ENABLED = process.env.ENABLE_PC_FOLDERS === 'true';

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 20 } });

// multer/busboy entrega originalname em latin1; reconverte para UTF-8 para não
// corromper acentos (ex.: "Razão.pdf" virava "RazÃ£o.pdf").
export function decodeUploadName(name) { return Buffer.from(name, 'latin1').toString('utf8'); }

// Passa o lote pelo antivírus (ClamAV). Devolve null e responde ao cliente se o
// scanner for obrigatório e estiver fora do ar; senão devolve { scanned, clean,
// rejected: [{name, virus}] } com os nomes já decodificados para exibição.
export async function scanOrReject(res, files) {
  try {
    const scan = await scanUploadBatch(files);
    return { ...scan, rejected: scan.rejected.map(r => ({ name: decodeUploadName(r.file.originalname), virus: r.virus })) };
  } catch (err) {
    res.status(err.status || 503).json({ error: err.message });
    return null;
  }
}

export function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

export function looksLikeFailedAssistantReply(content) {
  return /(?:arquivo[^.\n]{0,100}não foi (?:encontrado|gerado)|não há download disponível|não consegui (?:concluir|executar)|execução solicitada não foi concluída|nenhum resultado verificável foi produzido)/i
    .test(String(content || ''));
}

export async function loadAssistant(userId, id) {
  const a = id && await db.prepare('SELECT * FROM assistants WHERE id=? AND user_id=?').get(id, userId);
  if (!a) return null;
  return { ...a, tools: safeParse(a.tools, []), personality: safeParse(a.personality, {}) };
}

// Cria/verifica a conversa PARA o usuário informado. A checagem de existência é
// escopada por user_id (uma conversa de outro usuário não é reutilizada nem
// "adotada"); o INSERT grava o user_id.
export async function ensureConversation(userId, id, model) {
  const existing = await db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId);
  if (existing) return existing;
  // Se o id já existe mas é de OUTRO usuário, NÃO cria (evita colisão de PK e o
  // acesso indevido): retorna null → o chamador responde 404.
  if (await db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id)) return null;
  const t = now();
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, 'Nova conversa', model || process.env.DEEPSEEK_MODEL || 'deepseek-chat', t, t);
  workspaceFor(id, userId);
  return db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId);
}

// ---- Limite diário de mensagens por usuário (proteção numa SaaS) ----
// RATE_MSGS_PER_DAY = 0 (padrão) → sem limite (bom para instância pessoal).
// > 0 → cada usuário pode enviar no máximo N mensagens por dia. Registrado em
// usage_daily (contador por usuário e por dia, no fuso do app).
const RATE_MSGS_PER_DAY = Math.max(0, Number(process.env.RATE_MSGS_PER_DAY || 0));

// Contabiliza uma mensagem do usuário no dia de hoje e devolve o total já usado.
// Faz UPSERT atômico (INSERT ... ON CONFLICT ... RETURNING) para não perder
// contagem em envios simultâneos.
async function bumpDailyUsage(userId) {
  const day = scheduleDateKey(new Date(), scheduleTimeZone);
  const row = await db.prepare(
    `INSERT INTO usage_daily (user_id, day, msgs) VALUES (?,?,1)
     ON CONFLICT (user_id, day) DO UPDATE SET msgs = usage_daily.msgs + 1
     RETURNING msgs`
  ).get(userId, day);
  return Number(row?.msgs || 0);
}

// Aplica o limite ANTES de rodar o agente. Se estourar, devolve a mensagem de
// erro amigável (string); caso contrário devolve null (pode prosseguir).
export async function enforceDailyLimit(userId) {
  if (!RATE_MSGS_PER_DAY) return null; // sem limite configurado
  const used = await bumpDailyUsage(userId);
  if (used > RATE_MSGS_PER_DAY) {
    return `Você atingiu o limite de ${RATE_MSGS_PER_DAY} mensagens por dia deste plano. O contador zera amanhã. Se precisar de mais, fale com o administrador.`;
  }
  return null;
}
