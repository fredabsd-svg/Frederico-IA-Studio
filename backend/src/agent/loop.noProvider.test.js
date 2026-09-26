// Sem provedor utilizável, o runAgent NÃO pode terminar como "concluído".
//
// Caso real: uma tarefa agendada de uma conta sem chave de API aparecia como
// "Concluída" na fila. O caminho sem chave respondia com a orientação de
// cadastro, mas devolvia um resultado sem nenhuma marca de falha —
// `classifyTaskResult` caía no `done` (Regra 4.2: dependência ausente nunca
// vira sucesso).
//
// runAgent real + PostgreSQL real. Sem PostgreSQL, é pulado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-loop-nokey-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-loop-nokey-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.EMBEDDINGS_DISABLED = 'true';
delete process.env.FREE_TIER_API_KEY;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const { runAgent } = await import('./loop.js');
const { classifyTaskResult } = await import('../taskOutcome.js');

const stamp = Date.now();
const USER = `loop-nokey-${stamp}`;
const CONV = `loop-nokey-conv-${stamp}`;

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@t.local`, false, now(), now());
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(CONV, USER, 'Sem chave', '', now(), now());
}

test.after(async () => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  try { await db.prepare('DELETE FROM messages WHERE conversation_id=?').run(CONV); } catch {}
  try { await db.prepare('DELETE FROM conversations WHERE id=?').run(CONV); } catch {}
  try { await db.prepare('DELETE FROM "user" WHERE id=?').run(USER); } catch {}
});

test('conta sem chave: o run termina em falha explícita, não em "Concluída"', { skip }, async () => {
  const events = [];
  const result = await runAgent({
    userId: USER, conversationId: CONV, userText: 'Gere o relatório mensal', onEvent: e => events.push(e), interactive: false
  });
  assert.match(result.text, /Nenhuma chave de API configurada/);
  assert.equal(result.configurationError, true);
  assert.ok(result.failureMessage, 'a falha traz a mensagem para a fila de tarefas');
  const outcome = classifyTaskResult(result);
  assert.equal(outcome.status, 'error');
  assert.notEqual(outcome.progress, 'Concluida');
  // O estado persistido/emitido é de falha — a interface não pinta como pergunta pendente.
  assert.equal(result.execution?.state, 'fatal_error');
  const finalState = events.filter(e => e.type === 'run_state').at(-1);
  assert.equal(finalState.execution.state, 'fatal_error');
  const saved = await db.prepare("SELECT execution_meta FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(CONV);
  assert.equal(JSON.parse(saved.execution_meta).state, 'fatal_error');
});
