// Projetos dev no SERVIDOR (ADR 0004): a linha do banco carrega o projeto
// inteiro (permissões, modo), a lista deriva as conversas do vínculo real e
// apagar o projeto solta as conversas sem apagar histórico. Exige PostgreSQL.
import assert from 'node:assert/strict';
import test from 'node:test';
import { db, pool, now } from '../db.js';

let dbReady = true;
try { await pool.query('SELECT 1'); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const skipReason = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';
const dbTest = (name, fn) => test(name, { skip: skipReason }, fn);

const { upsertProject, listProjects, deleteProject, getProject, adoptConversations } = await import('./projectStore.js');

const USER = `devproj-user-${Date.now()}`;
const OTHER = `devproj-outro-${Date.now()}`;

async function seedUser(id) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING')
    .run(id, id, `${id}@teste.local`, true, now(), now());
}
async function seedConversation(userId, id) {
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, 'c', 'x::y', now(), now());
}

dbTest('upsert persiste permissões e modo; chamador antigo não apaga o registro', async () => {
  await seedUser(USER);
  const id = `p_${Date.now()}a`;
  await upsertProject(USER, {
    id, name: 'Meu app', mode: 'build',
    permissions: { githubWrite: true, githubWriteScope: { repo: 'a/b', branch: 'main', actions: ['push'] }, commandGrants: ['git clean*'] }
  });
  let row = await getProject(USER, id);
  assert.equal(row.mode, 'build');
  assert.equal(row.permissions.githubWrite, true);
  assert.deepEqual(row.permissions.commandGrants, ['git clean*']);

  // Upsert SEM o campo permissions (ex.: o espelhamento do loop.js) preserva o
  // registro do servidor — só quem envia o campo o substitui.
  await upsertProject(USER, { id, name: 'Meu app renomeado' });
  row = await getProject(USER, id);
  assert.equal(row.name, 'Meu app renomeado');
  assert.equal(row.permissions.githubWrite, true, 'permissões preservadas');
  assert.equal(row.mode, 'build', 'modo preservado');

  // Modo inválido não entra na coluna.
  await upsertProject(USER, { id, name: 'Meu app', mode: 'hackear' });
  assert.equal((await getProject(USER, id)).mode, 'build');
});

dbTest('listProjects deriva conversationIds do vínculo real, por dono', async () => {
  await seedUser(USER); await seedUser(OTHER);
  const id = `p_${Date.now()}b`;
  await upsertProject(USER, { id, name: 'Com conversas' });
  const c1 = `devproj-c1-${Date.now()}`;
  const c2 = `devproj-c2-${Date.now()}`;
  await seedConversation(USER, c1);
  await seedConversation(USER, c2);
  await adoptConversations(USER, id, [c1, c2]);
  const list = await listProjects(USER);
  const mine = list.find(p => p.id === id);
  assert.deepEqual([...mine.conversationIds].sort(), [c1, c2].sort());
  // Outro usuário não vê nada (isolamento).
  assert.equal((await listProjects(OTHER)).some(p => p.id === id), false);
});

dbTest('deleteProject solta as conversas em vez de apagar histórico', async () => {
  await seedUser(USER);
  const id = `p_${Date.now()}c`;
  await upsertProject(USER, { id, name: 'Descartável' });
  const conv = `devproj-del-${Date.now()}`;
  await seedConversation(USER, conv);
  await adoptConversations(USER, id, [conv]);
  assert.equal(await deleteProject(USER, id), true);
  assert.equal(await getProject(USER, id), null);
  const row = await db.prepare('SELECT project_id FROM conversations WHERE id=?').get(conv);
  assert.equal(row.project_id, null, 'a conversa sobrevive, sem projeto');
  // Apagar projeto de outro dono é recusado.
  assert.equal(await deleteProject(OTHER, id), false);
});
