// Rotas do Frederico Companion — a camada de experiência (assistente virtual)
// sobre a infraestrutura já existente do Studio (modelos, provedores, memória,
// modo desenvolvedor, ferramentas). Aqui vive apenas o ESTADO do Companion:
//   * configuração por usuário (personagem, persona/assistente, modelo, modo de
//     comportamento, nível de animação, nível de permissão, voz);
//   * a fila de eventos/alertas com transparência e auditoria (seção 8 e 9 da
//     proposta): origem, data/hora, projeto, importância, dados enviados,
//     ação proposta, autorização necessária e resultado.
// A inteligência continua sendo o núcleo do Studio — o Companion só o consome.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { makeRouter, loadAssistant, safeParse } from './helpers.js';

const router = makeRouter();

// Valores possíveis (fonte única de verdade — o front espelha estes).
const MODES = ['silencioso', 'auxiliar', 'proativo', 'foco', 'apresentacao'];
const ANIMATION_LEVELS = ['completo', 'reduzido', 'nenhum'];
const EVENT_LEVELS = ['info', 'aviso', 'critico'];
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

function serializeEvent(e) {
  return {
    id: e.id, kind: e.kind, level: e.level, title: e.title, detail: e.detail,
    origin: e.origin, project: e.project, dataSent: e.data_sent,
    proposedAction: e.proposed_action, authorization: e.authorization,
    result: e.result, status: e.status, createdAt: e.created_at, updatedAt: e.updated_at,
  };
}

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
  const id = nanoid();
  const t = now();
  await db.prepare(
    `INSERT INTO companion_events
     (id,user_id,kind,level,title,detail,origin,project,data_sent,proposed_action,authorization,result,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.userId, str(b.kind, 60) || 'geral', pick(b.level, EVENT_LEVELS, 'info'),
    str(b.title, 200), str(b.detail, 4000), str(b.origin, 60) || 'app', str(b.project, 200),
    str(b.dataSent, 4000), str(b.proposedAction, 2000), str(b.authorization, 60), str(b.result, 4000),
    'novo', t, t,
  );
  const row = await db.prepare('SELECT * FROM companion_events WHERE id=? AND user_id=?').get(id, req.userId);
  res.json(serializeEvent(row));
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

export default router;
