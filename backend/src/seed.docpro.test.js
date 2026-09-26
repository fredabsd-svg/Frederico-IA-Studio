// Migração do assistente "Documentos profissionais" para a persona atual.
//
// Desde o v4.2, o que fica gravado no assistente é só a PERSONA
// (`PERSONA_DOCUMENTOS`). Quando a persona muda, `seedDocProAssistant` só
// reconhece a anterior se ela estiver arquivada em `prompts/docpro/vN.txt` — e
// a do v4.2 nunca foi. Resultado silencioso: quem já tinha o assistente ficava
// com o texto antigo para sempre ("Frederico AI Studio", sem a regra da capa).
//
// Roda `ensureUserSeeded` real contra PostgreSQL real. Sem PostgreSQL, pulado.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'fred-seed-docpro-'));
process.env.EMBEDDINGS_DISABLED = 'true';

const { db, now } = await import('./db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('./migrate.js'); await runMigrations(); }
const skip = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const { ensureUserSeeded, DOCPRO_PROMPT } = await import('./seed.js');

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'docpro');
const PERSONA_V42 = fs.readFileSync(path.join(promptsDir, 'v14.txt'), 'utf8');
const stamp = Date.now();
const usuarios = [];

async function contaComDocPro(sufixo, prompt) {
  const id = `seed-docpro-${sufixo}-${stamp}`;
  usuarios.push(id);
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(id, id, `${id}@t.local`, false, now(), now());
  // Já tem assistentes: a semeadura dos padrões não roda de novo, só a migração.
  await db.prepare('INSERT INTO assistants (id,user_id,name,emoji,model,system_prompt,tools,personality,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(`${id}-a`, id, 'Documentos profissionais', 'file-pen-line', 'x', prompt, '[]', '{}', now(), now());
  return id;
}

async function promptDe(userId) {
  const linha = await db.prepare('SELECT system_prompt FROM assistants WHERE user_id=? AND name=?').get(userId, 'Documentos profissionais');
  return linha.system_prompt;
}

test.after(async () => {
  if (!dbReady) return;
  for (const id of usuarios) {
    try { await db.prepare('DELETE FROM assistants WHERE user_id=?').run(id); } catch {}
    try { await db.prepare('DELETE FROM templates WHERE user_id=?').run(id); } catch {}
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});

test('a persona do v4.2 (arquivada como v14) migra para a atual', { skip }, async () => {
  assert.notEqual(PERSONA_V42, DOCPRO_PROMPT, 'o teste precisa de uma persona ANTERIOR à atual');
  const id = await contaComDocPro('v42', PERSONA_V42);
  await ensureUserSeeded(id);
  assert.equal(await promptDe(id), DOCPRO_PROMPT);
});

test('a persona antiga com quebra de linha no fim também migra', { skip }, async () => {
  const id = await contaComDocPro('v42nl', `${PERSONA_V42}\n`);
  await ensureUserSeeded(id);
  assert.equal(await promptDe(id), DOCPRO_PROMPT);
});

test('prompt personalizado pelo usuário nunca é tocado', { skip }, async () => {
  const meu = `${PERSONA_V42}\nSempre com capa, é o padrão do meu escritório.`;
  const id = await contaComDocPro('custom', meu);
  await ensureUserSeeded(id);
  assert.equal(await promptDe(id), meu);
});
