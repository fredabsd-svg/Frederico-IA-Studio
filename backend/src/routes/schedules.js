// Rotas de schedules — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { normalizeScheduleDay, normalizeScheduleHour, scheduleDateKey, scheduleDue } from '../scheduling.js';
import { workspaceFor } from '../sandbox.js';
import { processTasks } from './tasks.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, scheduleTimeZone } from './helpers.js';

const router = makeRouter();

// ---- Rotinas agendadas (geram tarefas automaticamente na hora marcada) ----
async function runSchedule(s, d, markRun = true) {
  const convId = nanoid();
  const t = now();
  const runDate = scheduleDateKey(d, scheduleTimeZone);
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(convId, s.user_id, `Rotina: ${s.title} — ${runDate}`, s.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat', s.client_id || null, t, t);
  workspaceFor(convId);
  await db.prepare('INSERT INTO tasks (id,user_id,conversation_id,assistant_id,model,web_search,prompt,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(nanoid(), s.user_id, convId, s.assistant_id || null, s.model || null, s.web_search ? 1 : 0, s.prompt, 'queued', t);
  if (markRun) await db.prepare('UPDATE schedules SET last_run=? WHERE id=?').run(scheduleDateKey(d, scheduleTimeZone), s.id);
}
async function checkSchedules() {
  try {
    const d = new Date();
    let any = false;
    for (const s of await db.prepare('SELECT * FROM schedules WHERE enabled=1').all()) {
      if (scheduleDue(s, d, scheduleTimeZone)) { await runSchedule(s, d); any = true; }
    }
    if (any) processTasks().catch(() => {});
  } catch (e) { console.error('[rotinas]', e.message); }
}
// Timers armados pelo boot do server.js (depois das migrations).
export function startSchedulers() {
  setInterval(checkSchedules, 60 * 1000).unref();
  setTimeout(checkSchedules, 5000);
}

router.get('/schedules', async (req, res) => res.json(await db.prepare('SELECT * FROM schedules WHERE user_id=? ORDER BY created_at DESC').all(req.userId)));
router.post('/schedules', validate(schemas.scheduleCreate), async (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').trim();
  const prompt = (b.prompt || '').trim();
  if (!title || !prompt) return res.status(400).json({ error: 'Dê um nome e uma instrução para a rotina.' });
  const cadence = ['daily', 'weekly', 'monthly'].includes(b.cadence) ? b.cadence : 'monthly';
  const id = nanoid();
  await db.prepare('INSERT INTO schedules (id,user_id,title,prompt,assistant_id,model,client_id,web_search,cadence,day,hour,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, title, prompt, b.assistant_id || null, b.model || null, b.client_id || null, b.web_search ? 1 : 0, cadence, normalizeScheduleDay(cadence, b.day), normalizeScheduleHour(b.hour), 1, now());
  res.json(await db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').get(id, req.userId));
});
router.put('/schedules/:id', async (req, res) => {
  if (typeof req.body?.enabled !== 'undefined') await db.prepare('UPDATE schedules SET enabled=? WHERE id=? AND user_id=?').run(req.body.enabled ? 1 : 0, req.params.id, req.userId);
  res.json({ ok: true });
});
router.delete('/schedules/:id', async (req, res) => { await db.prepare('DELETE FROM schedules WHERE id=? AND user_id=?').run(req.params.id, req.userId); res.json({ ok: true }); });
router.post('/schedules/:id/run', async (req, res) => {
  const s = await db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!s) return res.status(404).json({ error: 'Não encontrado' });
  await runSchedule(s, new Date(), false); // execução manual não bloqueia a agendada do dia
  processTasks().catch(() => {});
  res.json({ ok: true });
});

export default router;
