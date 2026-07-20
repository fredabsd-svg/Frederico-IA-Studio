// Rotas de assistants — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, loadAssistant, safeParse } from './helpers.js';

const router = makeRouter();

// ---- Assistentes (Assistant Studio) ----
router.get('/assistants', async (req, res) => {
  res.json((await db.prepare('SELECT * FROM assistants WHERE user_id=? ORDER BY created_at ASC').all(req.userId))
    .map(a => ({ ...a, tools: safeParse(a.tools, []), personality: safeParse(a.personality, {}) })));
});

router.post('/assistants', validate(schemas.assistantCreate), async (req, res) => {
  const b = req.body; // nome e instruções garantidos por validate(schemas.assistantCreate)
  const id = nanoid();
  const t = now();
  await db.prepare('INSERT INTO assistants (id,user_id,name,emoji,color,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, b.name.trim(), b.emoji || 'bot', b.color || null, b.model || process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-chat', b.system_prompt, JSON.stringify(b.tools || []), JSON.stringify(b.personality || {}), t, t);
  res.json(await loadAssistant(req.userId, id));
});

router.put('/assistants/:id', validate(schemas.assistantUpdate), async (req, res) => {
  const b = req.body || {};
  const existing = await db.prepare('SELECT id FROM assistants WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Não encontrado' });
  await db.prepare('UPDATE assistants SET name=?, emoji=?, color=?, model=?, system_prompt=?, tools=?, personality=?, updated_at=? WHERE id=? AND user_id=?')
    .run(b.name?.trim() || 'Assistente', b.emoji || 'bot', b.color || null, b.model || null, b.system_prompt || '', JSON.stringify(b.tools || []), JSON.stringify(b.personality || {}), now(), req.params.id, req.userId);
  res.json(await loadAssistant(req.userId, req.params.id));
});

router.delete('/assistants/:id', async (req, res) => {
  const r = await db.prepare('DELETE FROM assistants WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  if (!r.changes) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ ok: true });
});

export default router;
