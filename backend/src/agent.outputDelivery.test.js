import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

process.env.WORKSPACE_ROOT = path.resolve('.test-workspaces', 'frederico-output-delivery-tests');
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
const {
  materializeTextOutput,
  isRetryableStreamError,
  shouldContinueAfterTruncation,
  shouldRepairExecution,
  shouldRepairOutputDelivery,
  textOutputPathFromClaim,
  persistAssistantReply
} = await import('./agent.js');
const { db, now } = await import('./db.js');

// O banco agora é PostgreSQL. Os testes que tocam o banco só rodam quando há um
// Postgres acessível (DATABASE_URL); sem ele, são pulados (não falham).
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('./migrate.js'); await runMigrations(); }

test('asks for repair when a response promises an output file that does not exist', () => {
  const before = new Map();
  const response = 'O relatório está disponível em /workspace/outputs/recursos_frederico_ai_studio.md.';

  assert.equal(shouldRepairOutputDelivery(response, before, []), true);
});

test('does not repair a response when the claimed file is actually present', () => {
  const response = 'O relatório está disponível em /workspace/outputs/recursos_frederico_ai_studio.md.';
  const files = [{ path: 'outputs/recursos_frederico_ai_studio.md', name: 'recursos_frederico_ai_studio.md', mtimeMs: 123, size: 10 }];

  assert.equal(shouldRepairOutputDelivery(response, new Map([['outputs/recursos_frederico_ai_studio.md', '123:10']]), files), false);
});

test('accepts only direct Markdown or text claims inside outputs for the fallback file', () => {
  assert.equal(textOutputPathFromClaim('Baixe em /workspace/outputs/relatorio.md.'), 'outputs/relatorio.md');
  assert.equal(textOutputPathFromClaim('Baixe em /workspace/outputs/../segredo.md.'), null);
  assert.equal(textOutputPathFromClaim('Baixe em /workspace/outputs/relatorio.xlsx.'), null);
});

test('materializes a promised Markdown report as a real output file', () => {
  const conversationId = `output-delivery-${Date.now()}`;
  const text = 'Relatório concluído. Baixe em /workspace/outputs/relatorio.md.';
  const relative = materializeTextOutput('user-output-delivery', conversationId, text);
  const target = path.join(process.env.WORKSPACE_ROOT, 'users', 'user-output-delivery', conversationId, relative);

  assert.equal(relative, 'outputs/relatorio.md');
  assert.equal(fs.readFileSync(target, 'utf8'), text);
});

test('persists a DOCX card with its assistant message before validation', { skip: dbReady ? false : 'requer PostgreSQL (DATABASE_URL)' }, async () => {
  const conversationId = `output-card-${Date.now()}`;
  const stamp = now();
  // A conversa pertence a um usuário (multi-tenant): cria o usuário e a conversa dele.
  const uid = `test-user-${Date.now()}`;
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(uid, 'Teste', `${uid}@t.com`, false, stamp, stamp);
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(conversationId, uid, 'Teste', 'modelo-teste', stamp, stamp);

  const result = await persistAssistantReply(uid, conversationId, 'Relatório pronto.', null, [{
    name: 'relatorio_ambiente_app.docx',
    path: 'outputs/relatorio_ambiente_app.docx',
    size: 2048
  }]);

  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].name, 'relatorio_ambiente_app.docx');
  const stored = await db.prepare('SELECT message_id,path FROM files WHERE id=?').get(result.cards[0].id);
  assert.equal(stored.message_id, result.msgId);
  assert.equal(stored.path, 'outputs/relatorio_ambiente_app.docx');
});

test('repairs an execution request when the model only returns a plan', () => {
  assert.equal(shouldRepairExecution({
    requiresExecution: true,
    requiresOutput: false,
    toolsAvailable: true,
    executedToolCalls: 0,
    outputsBefore: new Map(),
    outputsAfter: [],
    responseText: 'Vou estruturar o trabalho e o assistente principal deve executar o script depois.'
  }), true);
});

test('repairs a file request when no new output exists even after a tool call', () => {
  assert.equal(shouldRepairExecution({
    requiresExecution: true,
    requiresOutput: true,
    toolsAvailable: true,
    executedToolCalls: 1,
    outputsBefore: new Map(),
    outputsAfter: [],
    responseText: 'O relatorio esta pronto.'
  }), true);
});

test('accepts a completed execution when the requested output was created', () => {
  assert.equal(shouldRepairExecution({
    requiresExecution: true,
    requiresOutput: true,
    toolsAvailable: true,
    executedToolCalls: 1,
    outputsBefore: new Map(),
    outputsAfter: [{ path: 'outputs/relatorio.docx', mtimeMs: 321, size: 2048 }],
    responseText: 'O relatorio foi criado e verificado.'
  }), false);
});

test('continues a model response that ended only because of the output limit', () => {
  assert.equal(shouldContinueAfterTruncation('length', 0), true);
  assert.equal(shouldContinueAfterTruncation('length', 1), true);
  assert.equal(shouldContinueAfterTruncation('length', 2), false);
  assert.equal(shouldContinueAfterTruncation('stop', 0), false);
});

test('recognizes transient provider failures that can be retried safely', () => {
  assert.equal(isRetryableStreamError({ status: 504, message: 'Upstream idle timeout exceeded' }), true);
  assert.equal(isRetryableStreamError({ error: { code: 503, message: 'Provider unavailable' } }), true);
  assert.equal(isRetryableStreamError({ status: 401, message: 'Invalid API key' }), false);
});
