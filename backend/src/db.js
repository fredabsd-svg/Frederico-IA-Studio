// Camada de banco em PostgreSQL (pg puro), com uma fina casca de compatibilidade
// que preserva a forma antiga do better-sqlite3 — `db.prepare(sql).get/all/run(...)`
// — para minimizar o diff nos call sites. A ÚNICA diferença é que agora tudo é
// ASSÍNCRONO: cada .get()/.all()/.run() precisa de `await`.
//
// O que a casca faz por você:
//   * traduz placeholders `?` -> `$1,$2,...` (a base usa só `?` posicional);
//   * normaliza `undefined` -> `null` nos parâmetros (evita erro do pg);
//   * .run() devolve { changes } (como o better-sqlite3);
//   * db.transaction(fn) devolve uma função async que roda BEGIN/COMMIT/ROLLBACK
//     de verdade; chamadas db.prepare()/exec() feitas DENTRO de fn usam
//     automaticamente o mesmo cliente da transação (via AsyncLocalStorage).
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://studio:studio@localhost:5432/studio',
  max: Number(process.env.PG_POOL_MAX || 10),
});

// Um erro num cliente ocioso do pool não deve derrubar o processo inteiro.
pool.on('error', (err) => console.error('[pg] erro no cliente ocioso:', err.message));

// Guarda o cliente da transação em curso (se houver) para o fluxo assíncrono atual.
const txStore = new AsyncLocalStorage();

// Executor ativo: o cliente da transação corrente, ou o pool (autocommit).
function executor() {
  return txStore.getStore()?.client || pool;
}

// Traduz `?` -> `$1,$2,...`. A base de código usa apenas `?` como placeholder
// posicional (nunca `?` literal dentro de string SQL), então a troca é segura.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// pg rejeita `undefined`; o better-sqlite3 também exigia null explícito.
function norm(params) {
  return params.map((v) => (v === undefined ? null : v));
}

function prepare(sql) {
  const text = toPg(sql);
  return {
    async get(...params) {
      const r = await executor().query(text, norm(params));
      return r.rows[0];
    },
    async all(...params) {
      const r = await executor().query(text, norm(params));
      return r.rows;
    },
    async run(...params) {
      const r = await executor().query(text, norm(params));
      return { changes: r.rowCount, rowCount: r.rowCount };
    },
  };
}

// Executa SQL cru (sem parâmetros), útil para DDL/ad-hoc. Assíncrono.
async function exec(sql) {
  await executor().query(sql);
}

// Espelha db.transaction(fn) do better-sqlite3: devolve uma função que, ao ser
// chamada, roda fn dentro de uma transação. `fn` pode ser sync ou async e deve
// usar db.prepare()/db.exec() normalmente — as chamadas usam o cliente da
// transação graças ao AsyncLocalStorage.
function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStore.run({ client }, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  };
}

export const db = { prepare, exec, transaction };

export function now() { return new Date().toISOString(); }
