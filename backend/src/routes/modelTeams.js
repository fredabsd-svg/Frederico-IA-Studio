// Equipes de modelos (presets do sistema MULTIMODELO): combinações salvas de
// modelos + funções + modo de colaboração + limites, para reutilizar com um
// clique (ex.: "Equipe econômica", "Equipe de programação", "Equipe premium").
// Montado em /api pelo server.js.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { normalizeMultiModelConfig } from '../agent/multiModel.js';
import { validate, schemas } from '../validation.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();
const MAX_TEAMS = 30;

router.get('/model-teams', async (req, res) => {
  const rows = await db.prepare('SELECT id, name, config, created_at, updated_at FROM model_teams WHERE user_id=? ORDER BY updated_at DESC').all(req.userId);
  res.json(rows.map(r => {
    let config = null;
    try { config = JSON.parse(r.config); } catch {}
    return { id: r.id, name: r.name, config, created_at: r.created_at, updated_at: r.updated_at };
  }).filter(r => r.config));
});

router.post('/model-teams', validate(schemas.modelTeamCreate), async (req, res) => {
  const config = normalizeMultiModelConfig(req.body.config);
  if (!config) return res.status(400).json({ error: 'A equipe precisa de pelo menos 2 modelos válidos.' });
  const count = await db.prepare('SELECT COUNT(*)::int AS n FROM model_teams WHERE user_id=?').get(req.userId);
  if ((count?.n || 0) >= MAX_TEAMS) return res.status(400).json({ error: `Limite de ${MAX_TEAMS} equipes salvas atingido. Apague alguma antes de criar outra.` });
  const id = nanoid();
  const t = now();
  const name = req.body.name.trim();
  await db.prepare('INSERT INTO model_teams (id, user_id, name, config, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, req.userId, name, JSON.stringify(config), t, t);
  res.json({ id, name, config, created_at: t, updated_at: t });
});

router.delete('/model-teams/:id', async (req, res) => {
  const r = await db.prepare('DELETE FROM model_teams WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'Equipe não encontrada' });
  res.json({ ok: true });
});

export default router;
