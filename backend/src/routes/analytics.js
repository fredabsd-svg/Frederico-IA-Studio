// Rotas de analytics — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { db } from '../db.js';
import { makeRouter } from './helpers.js';

const router = makeRouter();

// ---- Analytics de uso (mensagens e tokens) ----
router.get('/analytics', async (req, res) => {
  const totals = await db.prepare('SELECT COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens FROM usage WHERE user_id=?').get(req.userId);
  totals.messages = Number(totals.messages);
  totals.tokens = Number(totals.tokens);
  totals.prompt_tokens = Number(totals.prompt_tokens);
  totals.completion_tokens = Number(totals.completion_tokens);
  const byAssistant = (await db.prepare(`
    SELECT COALESCE(a.name,'(sem assistente / equipe)') name, a.emoji,
           COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN assistants a ON a.id=u.assistant_id
    WHERE u.user_id=?
    GROUP BY u.assistant_id, a.name, a.emoji ORDER BY tokens DESC`).all(req.userId))
    .map(r => ({ ...r, messages: Number(r.messages), tokens: Number(r.tokens) }));
  const byModel = (await db.prepare('SELECT model, COUNT(*) messages, COALESCE(SUM(total_tokens),0) tokens FROM usage WHERE user_id=? GROUP BY model ORDER BY tokens DESC').all(req.userId))
    .map(r => ({ ...r, messages: Number(r.messages), tokens: Number(r.tokens) }));
  const byConversation = (await db.prepare(`
    SELECT COALESCE(c.title,'(conversa apagada)') title, COUNT(*) messages, COALESCE(SUM(u.total_tokens),0) tokens
    FROM usage u LEFT JOIN conversations c ON c.id=u.conversation_id
    WHERE u.user_id=?
    GROUP BY u.conversation_id, c.title ORDER BY tokens DESC LIMIT 15`).all(req.userId))
    .map(r => ({ ...r, messages: Number(r.messages), tokens: Number(r.tokens) }));
  res.json({ totals, byAssistant, byModel, byConversation });
});

export default router;
