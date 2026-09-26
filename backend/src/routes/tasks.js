// Rotas de tasks — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { nanoid } from 'nanoid';
import { recordUsage } from '../usage.js';
import { db, now } from '../db.js';
import { runAgent, setControl, isConversationActive, friendlyApiError } from '../agent.js';
import { classifyTaskResult } from '../taskOutcome.js';
import { isConversationId } from '../sandbox.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, ensureConversation, loadAssistant, enforceDailyLimit } from './helpers.js';
import { resolveFreeUsage } from '../userProvider.js';
import { enforceFreeTierLimits, bumpFreeTierUsage, logFreeTierEvent } from '../freeTier.js';
import { acquireFreeSlot } from '../freeQueue.js';

const router = makeRouter();

// Reserva ATÔMICA de uma tarefa da fila: só passa para 'running' se ela AINDA
// estiver 'queued'. Antes o UPDATE era só por id — um cancelamento que caísse
// entre o SELECT e o UPDATE era sobrescrito e a tarefa cancelada rodava mesmo
// assim. Devolve true quando a reserva é deste worker.
export async function claimQueuedTask(id) {
  const result = await db.prepare("UPDATE tasks SET status='running', started_at=?, progress_text='Iniciando...' WHERE id=? AND status='queued'").run(now(), id);
  return Number(result?.changes || 0) > 0;
}

// ---- Fila de tarefas (execução em segundo plano) ----
let taskWorkerBusy = false;
export async function processTasks() {
  if (taskWorkerBusy) return;
  taskWorkerBusy = true;
  try {
    while (true) {
      const t = await db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
      if (!t) break;
      if (!await claimQueuedTask(t.id)) continue; // cancelada (ou reservada) no intervalo
      const setProg = async (txt) => { try { await db.prepare('UPDATE tasks SET progress_text=? WHERE id=?').run(String(txt).slice(0, 200), t.id); } catch {} };
      let releaseFreeSlot = null;
      let freeProvider = null;
      try {
        await ensureConversation(t.user_id, t.conversation_id, t.model);
        const assistant = await loadAssistant(t.user_id, t.assistant_id);
        // MODO GRATUITO: tarefa em segundo plano também consome a chave da
        // plataforma quando o modelo cai nela — mesmos limites, fila e
        // contabilidade do chat (antes a fila de tarefas passava por fora).
        freeProvider = await resolveFreeUsage(t.user_id, [t.model || assistant?.model_ref || assistant?.model || '']);
        if (freeProvider) {
          const denial = await enforceFreeTierLimits(t.user_id);
          if (denial) {
            await logFreeTierEvent({ userId: t.user_id, model: freeProvider.model, status: denial.code === 'free_blocked' ? 'blocked' : 'limited', detail: `tarefa:${denial.code}` });
            await db.prepare("UPDATE tasks SET status='error', finished_at=?, error=?, progress_text=? WHERE id=?").run(now(), denial.error, 'Limite do modo gratuito', t.id);
            continue;
          }
          releaseFreeSlot = await acquireFreeSlot({ id: `task:${t.id}` });
        }
        const onEvent = (ev) => {
          if (ev.type === 'status') setProg(ev.content);
          else if (ev.type === 'tool_start') setProg(`Executando ${ev.name}...`);
        };
        // `interactive: false`: a tarefa roda em segundo plano, sem ninguém na
        // tela para responder. A ferramenta `ask_user` fica fora do inventário —
        // uma pergunta aqui deixaria a tarefa pendurada para sempre.
        const result = await runAgent({ userId: t.user_id, conversationId: t.conversation_id, userText: t.prompt, model: t.model, assistant, webSearch: !!t.web_search, interactive: false, onEvent });
        if (result?.usage) {
          await recordUsage({
            userId: t.user_id,
            conversationId: t.conversation_id,
            assistantId: t.assistant_id,
            model: result.model,
            kind: 'tarefa',
            feature: 'scheduled-task',
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
          });
        }
        if (freeProvider) {
          const tokens = result?.usage?.total_tokens || 0;
          await bumpFreeTierUsage(t.user_id, tokens);
          await logFreeTierEvent({ userId: t.user_id, model: result?.model || freeProvider.model, status: 'ok', detail: 'tarefa', tokens });
        }
        const outcome = classifyTaskResult(result);
        await db.prepare("UPDATE tasks SET status=?, finished_at=?, result_text=?, progress_text=?, error=? WHERE id=?")
          .run(outcome.status, now(), String(result?.text || '').slice(0, 300), outcome.progress, outcome.error, t.id);
      } catch (err) {
        console.error('[tarefa]', err);
        if (freeProvider && err?.code !== 'FREE_QUEUE_FULL') await logFreeTierEvent({ userId: t.user_id, model: freeProvider.model, status: 'error', detail: `tarefa: ${String(err?.message || err).slice(0, 200)}` });
        const error = err?.code === 'FREE_QUEUE_FULL'
          ? 'O modo gratuito estava com muitas solicitações. Crie a tarefa de novo em alguns minutos.'
          : friendlyApiError(err);
        await db.prepare("UPDATE tasks SET status='error', finished_at=?, error=? WHERE id=?").run(now(), error, t.id);
      } finally {
        releaseFreeSlot?.();
      }
    }
  } finally { taskWorkerBusy = false; }
}

// (o reenfileiramento de tarefas e o disparo do worker acontecem no boot, ao
// final do arquivo, depois que as migrations garantem que as tabelas existem)

router.post('/tasks', validate(schemas.task), async (req, res) => {
  // Presença/tamanho/trim garantidos por validate(schemas.task).
  const message = req.body.message;
  const convId = req.body.conversationId;
  if (!isConversationId(convId)) return res.status(400).json({ error: 'Identificador de conversa inválido.' });
  // Escopo por usuário: só cria a tarefa se a conversa for do próprio usuário
  // (conversa de outro → 404, nunca "adotada"). A POSSE vem ANTES do estado:
  // checar "está ativa?" primeiro devolvia 409 para a conversa de OUTRO
  // usuário que estivesse processando — revelando que ela existe.
  if (!await ensureConversation(req.userId, convId, req.body?.model)) return res.status(404).json({ error: 'Não encontrado' });
  if (isConversationActive(convId)) return res.status(409).json({ error: 'Esta conversa já está processando uma resposta. Aguarde terminar ou pare o processamento antes de criar uma tarefa nela.' });
  const limitMsg = await enforceDailyLimit(req.userId);
  if (limitMsg) return res.status(429).json({ error: limitMsg });
  const id = nanoid();
  await db.prepare('INSERT INTO tasks (id,user_id,conversation_id,assistant_id,model,web_search,prompt,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, convId, req.body?.assistantId || null, req.body?.model || null, req.body?.webSearch ? 1 : 0, message, 'queued', now());
  processTasks().catch(() => {});
  res.json({ id, status: 'queued' });
});

router.get('/tasks', async (req, res) => {
  res.json(await db.prepare(`
    SELECT t.*, c.title conv_title FROM tasks t
    LEFT JOIN conversations c ON c.id=t.conversation_id
    WHERE t.user_id=?
    ORDER BY t.created_at DESC LIMIT 20`).all(req.userId));
});

router.post('/tasks/:id/cancel', async (req, res) => {
  const t = await db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!t) return res.status(404).json({ error: 'Não encontrado' });
  if (t.status === 'queued') await db.prepare("UPDATE tasks SET status='canceled', finished_at=? WHERE id=?").run(now(), t.id);
  else if (t.status === 'running') setControl(t.conversation_id, 'stop');
  res.json({ ok: true });
});

export default router;
