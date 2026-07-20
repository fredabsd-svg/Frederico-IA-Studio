// Rotas de clients — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { validate, schemas } from '../validation.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

// ---- Clientes / Projetos ----
router.get('/clients', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM clients WHERE user_id=? ORDER BY name ASC').all(req.userId));
});

router.post('/clients', validate(schemas.client), async (req, res) => {
  const name = req.body.name; // presença/trim garantidos por validate(schemas.client)
  const id = nanoid();
  await db.prepare('INSERT INTO clients (id,user_id,name,created_at) VALUES (?,?,?,?)').run(id, req.userId, name, now());
  res.json({ id, name });
});

router.delete('/clients/:id', async (req, res) => {
  const existing = await db.prepare('SELECT id FROM clients WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: 'Não encontrado' });
  // Não destrutivo p/ as conversas: elas voltam para "Geral". Mas o conteúdo
  // PRIVADO indexado do cliente (memórias e trechos) é REMOVIDO — nunca
  // promovido a 'global', senão vazaria para as outras conversas.
  await db.prepare('UPDATE conversations SET client_id=NULL WHERE client_id=? AND user_id=?').run(req.params.id, req.userId);
  await db.prepare('DELETE FROM conversation_chunks WHERE scope=? AND user_id=?').run(`client:${req.params.id}`, req.userId);
  await db.prepare("DELETE FROM memory WHERE scope=? AND user_id=?").run(`client:${req.params.id}`, req.userId);
  await db.prepare("DELETE FROM memory_suggestions WHERE scope=? AND user_id=?").run(`client:${req.params.id}`, req.userId);
  await db.prepare('DELETE FROM clients WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

export default router;
