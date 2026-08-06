// F-08: retomada real pós-kill-9 com child_process.
// O processo A grava um checkpoint com tool calls e encerra (simula SIGKILL).
// O processo B carrega o checkpoint e prova que buildResumeMessages reconstrói
// o array sem duplicar ferramentas — fechando o caminho que o teste anterior
// só cobria com "morte de pool" no mesmo processo.
//
// Requer PostgreSQL (DATABASE_URL). Sem banco, todos os testes pulam com a
// mensagem padrão. As migrações rodam no início de cada processo filho
// (convenção do projeto: arquivos de teste rodam em paralelo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db, pool } from './db.js';
import { loadCheckpoint, buildResumeMessages, clearCheckpoint } from './agent/checkpoint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dbReady = true;
try { await pool.query('SELECT 1'); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('./migrate.js'); await runMigrations(); }
const skipReason = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';
const t = (name, fn) => test(name, { skip: skipReason }, fn);

const USER = 'f08-user-' + Date.now();
const CONV = 'f08-conv-' + Date.now();
const RUN_ID = 'r-kill9-real';

if (dbReady) {
  const stamp = new Date().toISOString();
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, 'Teste F-08', `${USER}@t.com`, false, stamp, stamp);
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(CONV, USER, 'Teste F-08', 'modelo-teste', stamp, stamp);
}

t('processo A grava checkpoint e encerra; processo B carrega e retoma sem duplicar ferramentas', async () => {
  // Processo A: grava checkpoint com tool calls e encerra (simulando kill -9).
  // O filho acessa o MESMO banco (DATABASE_URL do pai) e grava o estado.
  const childEnv = { ...process.env };
  const childArgs = JSON.stringify({
    action: 'save',
    userId: USER,
    conversationId: CONV,
    runId: RUN_ID,
    objective: 'Crie um arquivo de configuração nginx.',
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'Você é o agente.' },
      { role: 'user', content: 'Crie um arquivo de configuração nginx.' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{"command":"mkdir -p /workspace/nginx"}' } }
      ]},
      { role: 'tool', tool_call_id: 'tc1', content: '{"exitCode":0,"output":"diretório criado"}' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'tc2', type: 'function', function: { name: 'write_file', arguments: '{"path":"nginx/default.conf","content":"server { listen 80; }"}' } }
      ]},
      { role: 'tool', tool_call_id: 'tc2', content: '{"ok":true,"path":"nginx/default.conf"}' }
    ]
  });

  const childScript = path.join(__dirname, 'checkpoint.kill9.child.mjs');

  const child = fork(childScript, [childArgs], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    silent: false
  });

  const childResult = await new Promise((resolve, reject) => {
    child.on('message', msg => resolve(msg));
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0 && code !== null) reject(new Error(`processo A saiu com código ${code}`));
    });
    setTimeout(() => reject(new Error('timeout do processo A')), 15000);
  });

  assert.equal(childResult.ok, true, 'processo A deve salvar checkpoint com sucesso');

  // Processo B (este processo, simulando boot novo): carrega o checkpoint.
  const loaded = await loadCheckpoint(USER, CONV);
  assert.ok(loaded, 'processo B deve carregar checkpoint gravado por A');
  assert.equal(loaded.objective, 'Crie um arquivo de configuração nginx.');
  assert.equal(loaded.runId, RUN_ID);
  assert.equal(loaded.model, 'deepseek-chat');
  assert.equal(loaded.messages.length, 6, '6 mensagens (system + user + 2 pares assistant/tool)');

  // buildResumeMessages: o array de retomada NÃO duplica ferramentas.
  const resume = buildResumeMessages(loaded.messages, { objective: loaded.objective });
  assert.ok(resume.length >= loaded.messages.length + 1, 'resume adiciona nota de continuidade');

  // Verifica que tool_calls e tool_results estão emparelhados.
  const seq = resume.filter(m => m.role === 'assistant' || m.role === 'tool');
  assert.deepEqual(seq[0].tool_calls?.[0]?.id, 'tc1', 'tc1 antes do resultado tc1');
  assert.equal(seq[1].tool_call_id, 'tc1');
  assert.deepEqual(seq[2].tool_calls?.[0]?.id, 'tc2', 'tc2 antes do resultado tc2');
  assert.equal(seq[3].tool_call_id, 'tc2');

  // Nenhuma ferramenta duplicada: tc1 e tc2 aparecem exatamente uma vez cada.
  const toolCallIds = seq.filter(m => m.role === 'assistant' && m.tool_calls)
    .flatMap(m => m.tool_calls.map(tc => tc.id));
  assert.deepEqual(toolCallIds, ['tc1', 'tc2'], 'tool calls não duplicados');

  await clearCheckpoint(CONV);
});