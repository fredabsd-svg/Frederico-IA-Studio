// Rotas do Frederico Companion — a camada de experiência (assistente virtual)
// sobre a infraestrutura já existente do Studio (modelos, provedores, memória,
// modo desenvolvedor, ferramentas). Aqui vive apenas o ESTADO do Companion:
//   * configuração por usuário (personagem, persona/assistente, modelo, modo de
//     comportamento, nível de animação, nível de permissão, voz);
//   * a fila de eventos/alertas com transparência e auditoria (seção 8 e 9 da
//     proposta): origem, data/hora, projeto, importância, dados enviados,
//     ação proposta, autorização necessária e resultado.
// A inteligência continua sendo o núcleo do Studio — o Companion só o consome.
import { db, now } from '../db.js';
import { makeRouter, loadAssistant, safeParse } from './helpers.js';
import { isConversationId } from '../sandbox.js';
import { createEvent, serializeEvent } from '../companion/events.js';
import { checkGit, ingestLogs } from '../companion/monitor.js';
import { recordIncident, listIncidents, getIncident, updateIncident, findSimilar, incidentSignature } from '../companion/incidents.js';
import { audit, listAudit } from '../companion/audit.js';
import { analyzeBug } from '../companion/bugAnalysis.js';
import { incidentReportMarkdown } from '../companion/reports.js';

const router = makeRouter();

// Valores possíveis (fonte única de verdade — o front espelha estes).
const MODES = ['silencioso', 'auxiliar', 'proativo', 'foco', 'apresentacao'];
const ANIMATION_LEVELS = ['completo', 'reduzido', 'nenhum'];
const EVENT_STATUS = ['novo', 'visto', 'dispensado', 'resolvido'];
const CHARACTER_PRESETS = ['Luma', 'Clara', 'Pixel', 'Nova', 'Nexo', 'Fred', 'Echo'];

// Configuração padrão de um usuário que ainda não personalizou o Companion.
// Padrão conservador (seção 5): começa em modo "auxiliar" e permissão nível 1
// (somente leitura) — nada é executado sem o usuário pedir.
export const COMPANION_DEFAULTS = Object.freeze({
  enabled: true,
  characterName: 'Luma',
  assistantId: null,   // persona: qual assistente do Studio dá voz ao Companion
  model: '',           // vazio = usa o modelo atual da conversa/app
  mode: 'auxiliar',
  animationLevel: 'completo',
  permissionLevel: 1,  // 1..5 (seção 7)
  voice: false,
  proactiveAlerts: true,
});

const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const str = (v, max = 4000) => (v == null ? null : String(v).slice(0, max));

// Normaliza o payload de configuração vindo do cliente para uma forma segura,
// preenchendo com os padrões o que faltar/for inválido. Nunca confia no cliente.
export function sanitizeSettings(input = {}) {
  const d = COMPANION_DEFAULTS;
  return {
    enabled: input.enabled == null ? d.enabled : Boolean(input.enabled),
    characterName: (str(input.characterName, 40) || d.characterName).trim() || d.characterName,
    assistantId: input.assistantId ? String(input.assistantId).slice(0, 64) : null,
    model: str(input.model, 200) || '',
    mode: pick(input.mode, MODES, d.mode),
    animationLevel: pick(input.animationLevel, ANIMATION_LEVELS, d.animationLevel),
    permissionLevel: clampInt(input.permissionLevel, 1, 5, d.permissionLevel),
    voice: Boolean(input.voice),
    proactiveAlerts: input.proactiveAlerts == null ? d.proactiveAlerts : Boolean(input.proactiveAlerts),
  };
}

async function readSettings(userId) {
  const row = await db.prepare('SELECT settings FROM companion_settings WHERE user_id=?').get(userId);
  if (!row) return { ...COMPANION_DEFAULTS };
  return sanitizeSettings(safeParse(row.settings, {}));
}

// Se o assistente/persona apontado não existir mais (foi apagado), devolve o
// vínculo como null para o front não ficar preso a um id órfão.
async function resolvePersona(userId, settings) {
  if (!settings.assistantId) return null;
  const a = await loadAssistant(userId, settings.assistantId);
  return a ? { id: a.id, name: a.name, emoji: a.emoji, color: a.color, model: a.model } : null;
}

// serializeEvent/createEvent vivem em ../companion/events.js (compartilhados
// com o monitoramento).

// ---- Configuração ----------------------------------------------------------

// Estado completo do Companion: configuração + persona resolvida + eventos
// pendentes + as opções válidas (o front não precisa duplicar as listas).
router.get('/companion', async (req, res) => {
  const settings = await readSettings(req.userId);
  const persona = await resolvePersona(req.userId, settings);
  const events = (await db.prepare(
    `SELECT * FROM companion_events WHERE user_id=? AND status IN ('novo','visto')
     ORDER BY created_at DESC LIMIT 50`).all(req.userId)).map(serializeEvent);
  res.json({
    settings,
    persona,
    events,
    options: { modes: MODES, animationLevels: ANIMATION_LEVELS, characterPresets: CHARACTER_PRESETS },
  });
});

router.put('/companion', async (req, res) => {
  const settings = sanitizeSettings(req.body || {});
  const t = now();
  await db.prepare(
    `INSERT INTO companion_settings (user_id, settings, updated_at) VALUES (?,?,?)
     ON CONFLICT (user_id) DO UPDATE SET settings=excluded.settings, updated_at=excluded.updated_at`
  ).run(req.userId, JSON.stringify(settings), t);
  const persona = await resolvePersona(req.userId, settings);
  res.json({ settings, persona });
});

// ---- Eventos / alertas ------------------------------------------------------

router.get('/companion/events', async (req, res) => {
  const includeAll = req.query.all === '1';
  const rows = includeAll
    ? await db.prepare('SELECT * FROM companion_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.userId)
    : await db.prepare(`SELECT * FROM companion_events WHERE user_id=? AND status IN ('novo','visto') ORDER BY created_at DESC LIMIT 100`).all(req.userId);
  res.json(rows.map(serializeEvent));
});

// Cria um evento/alerta. Usado tanto pela interface quanto (no futuro) pelo
// agente local. Mantém o rastro exigido pela seção 9 (transparência/auditoria).
router.post('/companion/events', async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title é obrigatório' });
  res.json(await createEvent(req.userId, b));
});

// Atualiza o status de um evento (marcar como visto/dispensado/resolvido) e,
// opcionalmente, registra o resultado da execução.
router.patch('/companion/events/:id', async (req, res) => {
  const b = req.body || {};
  const existing = await db.prepare('SELECT * FROM companion_events WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Não encontrado' });
  const status = b.status ? pick(b.status, EVENT_STATUS, existing.status) : existing.status;
  const result = b.result !== undefined ? str(b.result, 4000) : existing.result;
  await db.prepare('UPDATE companion_events SET status=?, result=?, updated_at=? WHERE id=? AND user_id=?')
    .run(status, result, now(), req.params.id, req.userId);
  const row = await db.prepare('SELECT * FROM companion_events WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  res.json(serializeEvent(row));
});

// Dispensa todos os eventos pendentes de uma vez (botão "limpar alertas").
router.post('/companion/events/dismiss-all', async (req, res) => {
  await db.prepare(`UPDATE companion_events SET status='dispensado', updated_at=? WHERE user_id=? AND status IN ('novo','visto')`)
    .run(now(), req.userId);
  res.json({ ok: true });
});

// ---- Monitoramento (Fase 2: Companion de desenvolvimento) -------------------

// Verifica o Git do workspace da conversa e devolve o resumo (branch, arquivos
// alterados, ahead/behind). Quando o modo permite, cria o alerta de "sem commit"
// / "sem push" (uma única vez, sem repetir a cada ciclo). O front chama isto
// periodicamente enquanto há um projeto de desenvolvimento ativo.
router.post('/companion/monitor/git', async (req, res) => {
  const conversationId = String(req.body?.conversationId || '');
  if (!isConversationId(conversationId)) return res.status(400).json({ error: 'conversationId inválido' });
  // Posse OBRIGATÓRIA (regra multi-tenant do app): a conversa monitorada
  // precisa ser DO usuário logado — sem isto, qualquer usuário com o id de uma
  // conversa alheia leria branch/arquivos alterados do workspace de outro dono.
  const owned = await db.prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?').get(conversationId, req.userId);
  if (!owned) return res.status(404).json({ error: 'Não encontrado' });
  const settings = await readSettings(req.userId);
  const { status, event } = await checkGit(req.userId, conversationId, { settings, project: req.body?.project });
  res.json({ status, event });
});

// Ingestão de linhas de log/erro para detecção de erros recorrentes. As linhas
// são normalizadas em assinaturas e, ao cruzarem o limiar, viram alerta. Feita
// sob demanda pelo front (ex.: saída do terminal do modo dev) — no futuro, pelo
// agente local.
router.post('/companion/monitor/logs', async (req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 500) : (b.line ? [b.line] : []);
  const settings = await readSettings(req.userId);
  const events = await ingestLogs(req.userId, { source: b.source, project: b.project, lines }, { settings });
  res.json({ created: events.length, events });
});

// ---- Base de incidentes (memória técnica do copiloto) -----------------------

router.get('/companion/incidents', async (req, res) => {
  res.json(await listIncidents(req.userId, { project: req.query.project || null, status: req.query.status || null }));
});

router.post('/companion/incidents', async (req, res) => {
  const b = req.body || {};
  if (!b.summary && !b.errorMessage) return res.status(400).json({ error: 'summary ou errorMessage é obrigatório' });
  const out = await recordIncident(req.userId, b);
  res.json(out);
});

router.get('/companion/incidents/:id', async (req, res) => {
  const inc = await getIncident(req.userId, req.params.id);
  if (!inc) return res.status(404).json({ error: 'Não encontrado' });
  const similar = await findSimilar(req.userId, { signature: inc.signature, project: inc.project, excludeId: inc.id });
  res.json({ incident: inc, similar });
});

router.patch('/companion/incidents/:id', async (req, res) => {
  const inc = await updateIncident(req.userId, req.params.id, req.body || {});
  if (!inc) return res.status(404).json({ error: 'Não encontrado' });
  res.json(inc);
});

// Consulta de similaridade: "esse erro já ocorreu antes?" (antes de sugerir).
router.post('/companion/incidents/similar', async (req, res) => {
  const b = req.body || {};
  const signature = incidentSignature(b);
  res.json(await findSimilar(req.userId, { signature, project: b.project || null }));
});

// Análise de bug sob demanda (pura/local): causa provável + arquivos + severidade.
router.post('/companion/analyze', async (req, res) => {
  const b = req.body || {};
  res.json(analyzeBug({ errorMessage: b.errorMessage, stack: b.stack }));
});

// Relatório de diagnóstico de um incidente em Markdown (download).
router.get('/companion/incidents/:id/report.md', async (req, res) => {
  const inc = await getIncident(req.userId, req.params.id);
  if (!inc) return res.status(404).json({ error: 'Não encontrado' });
  const similar = await findSimilar(req.userId, { signature: inc.signature, project: inc.project, excludeId: inc.id });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="diagnostico_${inc.id}.md"`);
  res.send(incidentReportMarkdown(inc, { similar }));
});

// ---- Auditoria das ações do agente ------------------------------------------

router.get('/companion/audit', async (req, res) => {
  res.json(await listAudit(req.userId, { project: req.query.project || null, category: req.query.category || null }));
});

router.post('/companion/audit', async (req, res) => {
  const id = await audit(req.userId, req.body || {});
  res.json({ ok: !!id, id });
});

export default router;
