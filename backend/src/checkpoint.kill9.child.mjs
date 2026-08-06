// Processo filho do checkpoint.kill9.real.test.js.
// Recebe os parâmetros via argv[2] (JSON), roda migrações, insere
// user/conversa, salva checkpoint e encerra — simulando um kill -9
// do processo A. O processo pai (B) lê o checkpoint do banco.
import { db, pool } from './db.js';
import { saveCheckpoint } from './agent/checkpoint.js';

async function main() {
  const args = JSON.parse(process.argv[2] || '{}');
  const { action, userId, conversationId, runId, objective, model, messages } = args;

  if (action !== 'save') {
    process.send?.({ ok: false, error: 'ação desconhecida' });
    process.exit(1);
  }

  // Migrações: cada arquivo de teste roda as próprias migrações (convenção).
  const { runMigrations } = await import('./migrate.js');
  await runMigrations();

  // Insere user e conversa (o pai já fez, mas o filho pode rodar em paralelo
  // e o DB pode estar limpo — upsert evita conflito).
  const stamp = new Date().toISOString();
  try {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(userId, 'Teste F-08 Child', `${userId}@t.com`, false, stamp, stamp);
    await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
      .run(conversationId, userId, 'Teste F-08 Child', model || 'm', stamp, stamp);
  } catch (err) {
    process.send?.({ ok: false, error: `erro ao semear: ${err.message}` });
    process.exit(1);
  }

  // Grava o checkpoint como se fosse um run interrompido.
  const saved = await saveCheckpoint({
    userId,
    conversationId,
    runId: runId || 'r-child',
    objective: objective || 'objetivo',
    reason: 'step_limit',
    model: model || 'm',
    triedModels: [model || 'm'],
    step: 2,
    messages: messages || [],
    usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
    meta: { safePoint: 'after_tool_batch_child' }
  });

  if (!saved) {
    process.send?.({ ok: false, error: 'saveCheckpoint retornou false' });
    process.exit(1);
  }

  process.send?.({ ok: true });
  // Encerra IMEDIATAMENTE (simula kill -9: sem finally, sem cleanup).
  process.exit(0);
}

main().catch(err => {
  process.send?.({ ok: false, error: String(err?.message || err) });
  process.exit(1);
});
