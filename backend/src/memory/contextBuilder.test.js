import assert from 'node:assert/strict';
import test from 'node:test';

const { buildContext } = await import('./contextBuilder.js');
const { db } = await import('../db.js');

// O banco agora é PostgreSQL. Este teste só roda quando há um Postgres acessível
// (DATABASE_URL); sem ele, é pulado (não falha).
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }

test('does not attach stored context to a greeting', { skip: dbReady ? false : 'requer PostgreSQL (DATABASE_URL)' }, async () => {
  await db.prepare(`INSERT INTO memory (id, scope, content, created_at) VALUES (?,?,?,?)
    ON CONFLICT (id) DO UPDATE SET content=excluded.content`)
    .run('greeting-memory', 'global', 'Contexto antigo que nao deve aparecer numa saudacao.', '2026-01-01T00:00:00.000Z');
  await db.prepare(`INSERT INTO conversation_chunks (id, conversation_id, source_title, scope, content, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT (id) DO UPDATE SET content=excluded.content`)
    .run('greeting-chunk', 'old-conversation', 'Conversa anterior', 'global', 'Trecho antigo que nao deve aparecer numa saudacao.', '2026-01-01T00:00:00.000Z');

  const plan = await buildContext({
    conversationId: 'greeting-test',
    assistantId: 'assistant-test',
    userText: 'oi',
    model: 'ibm-granite/granite-4.0-h-micro'
  });

  assert.deepEqual(plan.blocks, []);
  assert.equal(plan.meta.retrievalSkipped, 'low_signal');
  assert.equal(plan.meta.stats.memoriesUsed, 0);
  assert.equal(plan.meta.stats.chunksUsed, 0);
});
