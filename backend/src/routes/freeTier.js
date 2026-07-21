// Rotas do MODO GRATUITO. Montado em /api pelo server.js.
//
// Usuário comum:
//   GET  /api/free-tier/status  — transparência: modelo/provedor em uso, fila,
//                                 mensagens restantes, horário de renovação.
//   POST /api/free-tier/opt-in  — adere/sai do modo gratuito (1º acesso).
//
// Administrador (ADMIN_EMAIL, mesmas regras do backup):
//   GET    /api/admin/free-tier             — visão geral (usuários, consumo,
//                                             erros, bloqueados, configurações)
//   PUT    /api/admin/free-tier/settings    — liga/desliga, limite diário,
//                                             modelos desativados
//   POST   /api/admin/free-tier/block       — bloqueia usuário por abuso
//   DELETE /api/admin/free-tier/block/:id   — desbloqueia
//   PUT    /api/admin/free-tier/user-limit  — limite individual (ou remove)
import { db, now } from '../db.js';
import { makeRouter, isAdmin } from './helpers.js';
import { getUserProvider } from '../userProvider.js';
import { freeQueueSnapshot } from '../freeQueue.js';
import {
  freeTierConfigured, getFreeTierConfig, freeTierStatusFor, setFreeModeOptIn,
  blockFreeTierUser, unblockFreeTierUser, saveFreeTierSetting
} from '../freeTier.js';

const router = makeRouter();

// ---- Usuário ----
router.get('/free-tier/status', async (req, res) => {
  if (!freeTierConfigured()) return res.json({ configured: false, isAdmin: isAdmin(req) });
  const prov = await getUserProvider(req.userId);
  const status = await freeTierStatusFor(req.userId, { source: prov.source });
  res.json({
    ...status,
    hasOwnKey: prov.source === 'user',
    hasAnyKey: prov.hasKey,         // já consegue conversar (própria/servidor/free)?
    queue: freeQueueSnapshot(),
    isAdmin: isAdmin(req)
  });
});

router.post('/free-tier/opt-in', async (req, res) => {
  if (!freeTierConfigured()) return res.status(400).json({ error: 'O modo gratuito não está disponível neste servidor.' });
  const enable = req.body?.enable !== false;
  await setFreeModeOptIn(req.userId, enable);
  const prov = await getUserProvider(req.userId);
  res.json({ ok: true, optedIn: enable, active: prov.source === 'free' });
});

// ---- Admin ----
function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.status(403).json({ error: 'Apenas o administrador pode acessar este painel.' });
  return false;
}

router.get('/admin/free-tier', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const config = await getFreeTierConfig();
  const today = new Date().toISOString().slice(0, 10);
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Usuários no modo gratuito, com consumo de hoje e acumulado.
  const users = await db.prepare(`
    SELECT u.id, u.email, u.name,
           COALESCE(hoje.msgs, 0)   msgs_hoje,
           COALESCE(hoje.tokens, 0) tokens_hoje,
           COALESCE(total.msgs, 0)  msgs_total,
           COALESCE(total.tokens,0) tokens_total,
           lim.msgs_per_day         limite_individual,
           (b.user_id IS NOT NULL)  bloqueado,
           b.reason                 motivo_bloqueio
    FROM user_settings s
    JOIN "user" u ON u.id = s.user_id
    LEFT JOIN free_tier_usage hoje ON hoje.user_id = s.user_id AND hoje.day = ?
    LEFT JOIN (SELECT user_id, SUM(msgs) msgs, SUM(tokens) tokens FROM free_tier_usage GROUP BY user_id) total ON total.user_id = s.user_id
    LEFT JOIN free_tier_user_limits lim ON lim.user_id = s.user_id
    LEFT JOIN free_tier_blocks b ON b.user_id = s.user_id
    WHERE s.free_mode = 1
    ORDER BY COALESCE(total.msgs, 0) DESC`).all(today);

  // Consumo por modelo (30 dias) e por dia (14 dias) — de free_tier_events.
  const byModel = await db.prepare(`
    SELECT model, COUNT(*) requisicoes, COALESCE(SUM(tokens),0) tokens,
           COUNT(*) FILTER (WHERE status <> 'ok') falhas
    FROM free_tier_events WHERE created_at >= ? GROUP BY model ORDER BY requisicoes DESC`).all(since30);
  const byDay = await db.prepare(`
    SELECT substr(created_at, 1, 10) dia, COUNT(*) requisicoes,
           COALESCE(SUM(tokens),0) tokens,
           COUNT(*) FILTER (WHERE status = 'error') erros,
           COUNT(*) FILTER (WHERE status = 'limited') limitadas
    FROM free_tier_events WHERE created_at >= ? GROUP BY 1 ORDER BY 1 DESC LIMIT 14`)
    .all(new Date(Date.now() - 14 * 86_400_000).toISOString());

  // Últimos erros/indisponibilidades (para diagnóstico rápido).
  const errors = await db.prepare(`
    SELECT e.created_at, u.email, e.model, e.status, e.detail
    FROM free_tier_events e LEFT JOIN "user" u ON u.id = e.user_id
    WHERE e.status <> 'ok' ORDER BY e.created_at DESC LIMIT 50`).all();

  const blocked = await db.prepare(`
    SELECT b.user_id, u.email, u.name, b.reason, b.created_at
    FROM free_tier_blocks b LEFT JOIN "user" u ON u.id = b.user_id
    ORDER BY b.created_at DESC`).all();

  const totals = await db.prepare(`
    SELECT COUNT(*) requisicoes, COALESCE(SUM(tokens),0) tokens,
           COUNT(DISTINCT user_id) usuarios,
           COUNT(*) FILTER (WHERE status = 'error') erros
    FROM free_tier_events WHERE created_at >= ?`).get(since30);

  res.json({
    config: {
      configured: config.configured,
      enabled: config.enabled,
      provider: config.providerName,
      baseURL: config.baseURL,
      msgsPerDay: config.msgsPerDay,
      msgsPerMin: config.msgsPerMin,
      allModels: config.allModels,
      disabledModels: config.disabledModels
    },
    queue: freeQueueSnapshot(),
    totals: {
      usuariosAtivos: users.filter(u => !u.bloqueado).length,
      requisicoes30d: Number(totals?.requisicoes || 0),
      tokens30d: Number(totals?.tokens || 0),
      usuarios30d: Number(totals?.usuarios || 0),
      erros30d: Number(totals?.erros || 0)
    },
    users: users.map(u => ({
      ...u,
      msgs_hoje: Number(u.msgs_hoje), tokens_hoje: Number(u.tokens_hoje),
      msgs_total: Number(u.msgs_total), tokens_total: Number(u.tokens_total),
      bloqueado: Boolean(u.bloqueado)
    })),
    byModel: byModel.map(r => ({ ...r, requisicoes: Number(r.requisicoes), tokens: Number(r.tokens), falhas: Number(r.falhas) })),
    byDay: byDay.map(r => ({ ...r, requisicoes: Number(r.requisicoes), tokens: Number(r.tokens), erros: Number(r.erros), limitadas: Number(r.limitadas) })),
    errors,
    blocked
  });
});

router.put('/admin/free-tier/settings', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  if (body.enabled !== undefined) await saveFreeTierSetting('enabled', body.enabled ? '1' : '0');
  if (body.msgsPerDay !== undefined) {
    const value = Math.max(1, Math.min(10_000, Number(body.msgsPerDay) || 0));
    if (!value) return res.status(400).json({ error: 'Limite diário inválido.' });
    await saveFreeTierSetting('msgs_per_day', String(value));
  }
  if (body.disabledModels !== undefined) {
    const list = Array.isArray(body.disabledModels) ? body.disabledModels.map(String).slice(0, 50) : [];
    await saveFreeTierSetting('disabled_models', JSON.stringify(list));
  }
  res.json({ ok: true, config: await getFreeTierConfig() });
});

router.post('/admin/free-tier/block', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'Informe o usuário.' });
  await blockFreeTierUser(userId, req.body?.reason);
  res.json({ ok: true });
});

router.delete('/admin/free-tier/block/:userId', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await unblockFreeTierUser(req.params.userId);
  res.json({ ok: true });
});

router.put('/admin/free-tier/user-limit', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'Informe o usuário.' });
  const value = req.body?.msgsPerDay;
  if (value === null || value === undefined || value === '') {
    await db.prepare('DELETE FROM free_tier_user_limits WHERE user_id=?').run(userId);
    return res.json({ ok: true, removed: true });
  }
  const limit = Math.max(1, Math.min(10_000, Number(value) || 0));
  if (!limit) return res.status(400).json({ error: 'Limite inválido.' });
  await db.prepare(`INSERT INTO free_tier_user_limits (user_id, msgs_per_day, updated_at) VALUES (?,?,?)
    ON CONFLICT (user_id) DO UPDATE SET msgs_per_day=excluded.msgs_per_day, updated_at=excluded.updated_at`)
    .run(userId, limit, now());
  res.json({ ok: true, msgsPerDay: limit });
});

export default router;
