// Runner de migrations simples: lê backend/migrations/*.sql em ordem alfabética,
// aplica as que ainda não rodaram e registra em schema_migrations. Cada migration
// roda dentro de uma transação (tudo ou nada). Chamado no boot do backend.
//
// Um LOCK consultivo do Postgres (pg_advisory_lock) serializa a migração entre
// processos/conexões: se dois processos subirem ao mesmo tempo (ex.: dois testes
// em paralelo, ou duas instâncias do backend), só um migra por vez e o outro
// espera e depois vê tudo já aplicado — sem corrida no schema_migrations.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_LOCK = 727272001; // chave arbitrária e fixa do advisory lock

export async function runMigrations() {
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    for (const file of files) {
      const already = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (already.rowCount) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] aplicada: ${file}`);
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        console.error(`[migrate] FALHOU em ${file}: ${e.message}`);
        throw e;
      }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); } catch {}
    client.release();
  }
}
