// Painel operacional — métricas agregadas de uso por feature.
//
// O que esta rota responde:
//   * Total de requests e tokens HOJE / 7d / 30d por feature
//   * Custo estimado USD no mês corrente
//   * Pressão de cota (% de usuários perto do teto diário free-tier)
//   * Top 5 usuários por consumo de tokens (30d)
//   * Distribuição por modelo (10 mais usados no mês)
//
// O que esta rota NÃO faz:
//   * Listar linhas individuais de `usage` — use `analytics` com auth do
//     próprio usuário para isso (privacidade).
//   * Mutações — só leitura. Purge e outras ações vivem em outras rotas.
//
// Performance: as agregações usam índices existentes (`idx_usage_created_at`,
// `idx_usage_feature`, `idx_usage_user_id`). Sem índices, o painel seria O(N)
// sobre a tabela inteira a cada chamada. Ver migration 031.

import { db } from '../db.js';
import { makeRouter, requireAdmin } from './helpers.js';

const router = makeRouter();

// Helper: devolve o início do dia UTC para a data passada. Usado nos filtros
// "hoje" / "últimos 7d" — manter em UTC é importante: o app não tem fuso
// configurável, e usar local server time causaria discrepância entre
// instâncias (containers diferentes).
function startOfUtcDay(offsetDays = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

// Helper: converte row crua do SQLite/Postgres em inteiro JS. pg devolve
// strings para BIGINT e NUMBER para INT. Aqui tudo cabe em INT (counts e
// tokens agregados raramente excedem 2^31); usamos Number().
function n(v) { return Number(v || 0); }

async function totalsByFeature(sinceIso) {
  const rows = await db.prepare(
    `SELECT COALESCE(feature,'(sem feature)') AS feature,
            COUNT(*)::int AS requests,
            COALESCE(SUM(total_tokens),0)::bigint AS tokens,
            COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM usage
      WHERE created_at >= ?
      GROUP BY feature
      ORDER BY tokens DESC`
  ).all(sinceIso);
  return rows.map(r => ({
    feature: r.feature,
    requests: n(r.requests),
    tokens: n(r.tokens),
    costUsd: Number(r.cost_usd || 0),
  }));
}

async function topUsers(sinceIso, limit = 5) {
  const rows = await db.prepare(
    `SELECT u.user_id,
            COALESCE(u.name, u.email, u.user_id) AS display,
            COUNT(*)::int AS requests,
            COALESCE(SUM(u.total_tokens),0)::bigint AS tokens
       FROM usage u
       LEFT JOIN "user" usr ON usr.id = u.user_id
      WHERE u.created_at >= ?
      GROUP BY u.user_id, usr.name, usr.email
      ORDER BY tokens DESC
      LIMIT ?`
  ).all(sinceIso, limit);
  return rows.map(r => ({
    userId: r.user_id,
    display: r.display,
    requests: n(r.requests),
    tokens: n(r.tokens),
  }));
}

async function topModels(sinceIso, limit = 10) {
  const rows = await db.prepare(
    `SELECT COALESCE(model,'(sem modelo)') AS model,
            COUNT(*)::int AS requests,
            COALESCE(SUM(total_tokens),0)::bigint AS tokens
       FROM usage
      WHERE created_at >= ?
      GROUP BY model
      ORDER BY tokens DESC
      LIMIT ?`
  ).all(sinceIso, limit);
  return rows.map(r => ({
    model: r.model,
    requests: n(r.requests),
    tokens: n(r.tokens),
  }));
}

// Pressão de cota: % dos usuários ativos nos últimos 7 dias que gastaram
// mais de 80% do teto diário free-tier. Sem teto configurado, devolve null
// em vez de inventar um número — a UI mostra "tier não configurado".
async function quotaPressure() {
  const limit = Number(process.env.FREE_TIER_DAILY_LIMIT || 0);
  if (!Number.isFinite(limit) || limit <= 0) return { configured: false, limit: 0 };

  const threshold = limit * 0.8;
  const since = startOfUtcDay(-7);
  const rows = await db.prepare(
    `SELECT user_id, SUM(total_tokens)::bigint AS tokens
       FROM usage
      WHERE created_at >= ?
      GROUP BY user_id`
  ).all(since);

  if (!rows.length) return { configured: true, limit, activeUsers: 0, pressuredUsers: 0, ratio: 0 };

  // "Pressão" aqui = tokens totais nos últimos 7 dias / (7 * limit).
  // Quem passou de 80% do orçamento diário x 7d está próximo do teto.
  let pressured = 0;
  for (const r of rows) {
    if (n(r.tokens) >= threshold * 7) pressured += 1;
  }

  return {
    configured: true,
    limit,
    activeUsers: rows.length,
    pressuredUsers: pressured,
    ratio: rows.length ? Number((pressured / rows.length).toFixed(3)) : 0,
  };
}

// GET /api/admin/usage/dashboard
// Retorna agregado operacional completo. Pensado para o painel admin ou
// para um agente externo que precise de healthcheck de uso.
router.get('/admin/usage/dashboard', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const today = startOfUtcDay(0);
  const d7 = startOfUtcDay(-7);
  const d30 = startOfUtcDay(-30);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString();

  // Roda as 4 agregações em paralelo — cada uma é um SELECT independente e
  // o pool do `pg` lida bem com concorrência limitada.
  const [todayByFeature, weekByFeature, monthByFeature, top, models, pressure] = await Promise.all([
    totalsByFeature(today),
    totalsByFeature(d7),
    totalsByFeature(d30),
    topUsers(d30, 5),
    topModels(monthStartIso, 10),
    quotaPressure(),
  ]);

  const monthCost = monthByFeature.reduce((sum, r) => sum + r.costUsd, 0);
  const monthTokens = monthByFeature.reduce((sum, r) => sum + r.tokens, 0);

  res.json({
    generatedAt: new Date().toISOString(),
    ranges: { today, d7, d30, monthStart: monthStartIso },
    today: { byFeature: todayByFeature },
    last7d: { byFeature: weekByFeature },
    last30d: { byFeature: monthByFeature },
    month: {
      tokens: monthTokens,
      costUsd: Number(monthCost.toFixed(4)),
      topModels: models,
    },
    quotaPressure: pressure,
    topUsers30d: top,
    // Notas pra UI: lista canônica de features conhecidas — se a base tem
    // algo fora, aparece nos `byFeature` como label crua, mas a UI pode
    // decidir esconder.
    knownFeatures: ['chat', 'multimodel', 'design', 'design-image', 'scheduled-task'],
  });
});

export default router;
export { totalsByFeature, topUsers, topModels, quotaPressure, startOfUtcDay };