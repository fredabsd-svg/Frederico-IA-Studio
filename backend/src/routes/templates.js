// Rotas de templates — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { validate, schemas } from '../validation.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

// ---- Templates de pedido ----
router.get('/templates', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM templates WHERE user_id=? ORDER BY created_at ASC').all(req.userId));
});

router.post('/templates', validate(schemas.template), async (req, res) => {
  // Presença/trim garantidos por validate(schemas.template).
  const { name, content } = req.body;
  const id = nanoid();
  await db.prepare('INSERT INTO templates (id,user_id,name,content,created_at) VALUES (?,?,?,?,?)').run(id, req.userId, name, content, now());
  res.json({ id, name, content });
});

router.delete('/templates/:id', async (req, res) => {
  await db.prepare('DELETE FROM templates WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

export default router;
