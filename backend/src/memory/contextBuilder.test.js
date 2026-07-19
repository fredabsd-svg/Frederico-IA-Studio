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

test('injeta a nota manual global do usuário numa pergunta com assunto', { skip: dbReady ? false : 'requer PostgreSQL (DATABASE_URL)' }, async () => {
  // Regressão do achado de auditoria: memória salva + buscável no painel deve
  // CHEGAR ao assistente. Uma nota manual de escopo global tem de aparecer no
  // contexto de uma nova conversa (clientScope=null), sem depender de embeddings.
  const uid = 'user-mem-regressao';
  await db.prepare(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (?,?,?,?,now(),now()) ON CONFLICT (id) DO NOTHING`)
    .run(uid, 'Teste Memória', 'mem-regressao@teste.local', true);
  await db.prepare(`INSERT INTO memory (id, user_id, scope, content, type, importance, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET content=excluded.content`)
    .run('mem-cliente-prioritario', uid, 'global',
      'O cliente prioritário do escritório é a Aurora Alimentos Ltda e o contato é João Almeida.',
      'manual', 4, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z');

  const plan = await buildContext({
    userId: uid,
    conversationId: 'conv-mem-regressao',
    assistantId: 'asst-mem',
    clientScope: null,
    userText: 'quem é o cliente prioritário do escritório e quem é o contato dele?',
    model: 'anthropic/claude-sonnet-5'
  });

  const texto = (plan.blocks || []).join('\n');
  assert.match(texto, /NOTAS SALVAS PELO USUARIO/);
  assert.match(texto, /Aurora Alimentos/);
  assert.match(texto, /João Almeida/);
});
