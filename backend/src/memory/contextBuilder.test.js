import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = ':memory:';
const { buildContext } = await import('./contextBuilder.js');
const { db } = await import('../db.js');

test('does not attach stored context to a greeting', async () => {
  db.prepare('INSERT OR REPLACE INTO memory (id, scope, content, created_at) VALUES (?,?,?,?)')
    .run('greeting-memory', 'global', 'Contexto antigo que nao deve aparecer numa saudacao.', '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT OR REPLACE INTO conversation_chunks (id, conversation_id, source_title, scope, content, created_at) VALUES (?,?,?,?,?,?)')
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
