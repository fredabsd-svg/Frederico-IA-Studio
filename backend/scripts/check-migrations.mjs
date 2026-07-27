#!/usr/bin/env node
// Verificação das migrações contra um PostgreSQL REAL.
//
// Antes, nada disso rodava no CI: as migrações só eram exercitadas quando
// alguém subia o app. Este script executa o ciclo que a auditoria pediu:
//   1) banco vazio → aplica TODAS as migrações;
//   2) aplica de novo → tem de ser no-op (idempotência);
//   3) confere que as tabelas essenciais existem;
//   4) confere que schema_migrations bateu com os arquivos em migrations/.
//
// Uso: DATABASE_URL=postgres://... node scripts/check-migrations.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, db } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Tabelas que o app assume existirem em runtime. Se uma migração for renomeada
// ou perdida, isto falha aqui e não em produção.
const REQUIRED_TABLES = [
  'schema_migrations', 'user', 'session', 'account',
  'conversations', 'messages', 'files', 'assistants', 'templates',
  'memory', 'conversation_chunks', 'usage', 'usage_daily',
  'tasks', 'schedules', 'clients', 'user_settings', 'user_ai_providers',
  'user_connectors', 'user_consents', 'execution_checkpoints',
  'model_teams', 'companion_events', 'document_processings',
  'user_roles', 'admin_audit',
  'design_projects', 'design_versions', 'design_systems', 'design_messages'
];

function fail(message) {
  console.error(`[migrations] FALHOU: ${message}`);
  process.exitCode = 1;
}

const arquivos = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
console.log(`[migrations] ${arquivos.length} arquivo(s) em migrations/.`);

// 1) Banco vazio → todas as migrações.
await runMigrations();
const aplicadas = await db.prepare('SELECT name FROM schema_migrations ORDER BY name').all();
console.log(`[migrations] ${aplicadas.length} aplicada(s).`);
if (aplicadas.length !== arquivos.length) {
  fail(`esperava ${arquivos.length} migrações aplicadas, encontrei ${aplicadas.length}.`);
}
const faltando = arquivos.filter(f => !aplicadas.some(a => a.name === f));
if (faltando.length) fail(`não aplicadas: ${faltando.join(', ')}`);

// 2) Reaplicar tem de ser no-op (idempotência / reinício do backend).
await runMigrations();
const depois = await db.prepare('SELECT COUNT(*)::int AS n FROM schema_migrations').get();
if (Number(depois.n) !== aplicadas.length) {
  fail(`a segunda execução mudou schema_migrations (${aplicadas.length} → ${depois.n}).`);
} else {
  console.log('[migrations] reexecução é no-op (idempotente).');
}

// 3) Tabelas essenciais.
const existentes = new Set(
  (await db.prepare("SELECT tablename FROM pg_tables WHERE schemaname='public'").all()).map(r => r.tablename)
);
const ausentes = REQUIRED_TABLES.filter(t => !existentes.has(t));
if (ausentes.length) fail(`tabelas essenciais ausentes: ${ausentes.join(', ')}`);
else console.log(`[migrations] ${REQUIRED_TABLES.length} tabela(s) essencial(is) presente(s).`);

// 4) Operação básica de escrita/leitura, provando que o schema é utilizável.
const uid = `ci-migrations-${Date.now()}`;
try {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(uid, 'CI', `${uid}@ci.local`, false, new Date().toISOString(), new Date().toISOString());
  const stamp = new Date().toISOString();
  await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(`${uid}-conv`, uid, 'CI', 'modelo-teste', stamp, stamp);
  await db.prepare('DELETE FROM "user" WHERE id=?').run(uid); // cascade leva a conversa junto
  const sobrou = await db.prepare('SELECT 1 FROM conversations WHERE id=?').get(`${uid}-conv`);
  if (sobrou) fail('ON DELETE CASCADE de conversations não funcionou.');
  else console.log('[migrations] escrita, leitura e cascade OK.');
} catch (e) {
  fail(`operação básica no schema falhou: ${e.message}`);
}

await pool.end();
if (!process.exitCode) console.log('[migrations] tudo certo.');
