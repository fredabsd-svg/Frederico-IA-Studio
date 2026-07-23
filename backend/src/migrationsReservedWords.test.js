import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regressão: uma migration que usa uma PALAVRA RESERVADA do PostgreSQL como
// nome de coluna SEM aspas quebra no boot (runMigrations lança → o backend faz
// process.exit(1) → ninguém consegue logar). Já aconteceu com a coluna
// `authorization` (015_companion). Este teste varre TODAS as migrations e falha
// se encontrar uma definição de coluna com identificador reservado sem aspas.

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Subconjunto das palavras reservadas do PostgreSQL que NÃO podem ser nome de
// coluna sem aspas (as que mais aparecem por engano em schemas).
const RESERVED = new Set([
  'authorization', 'user', 'order', 'group', 'table', 'column', 'select',
  'where', 'from', 'references', 'primary', 'default', 'check', 'constraint',
  'unique', 'limit', 'offset', 'desc', 'asc', 'end', 'grant', 'using',
  'window', 'collation', 'array', 'both', 'case', 'cast', 'all', 'and', 'or',
  'not', 'null', 'true', 'false', 'foreign', 'having', 'union', 'when', 'then',
]);

// Tipos que indicam que a linha é uma DEFINIÇÃO de coluna (id <tipo>).
const COL_TYPE = 'text|integer|int|bigint|smallint|serial|bigserial|boolean|bool|timestamptz|timestamp|date|time|numeric|decimal|real|double|json|jsonb|uuid|bytea|varchar|char';

// Remove comentários de linha (-- ...) para não gerar falso positivo.
function stripComments(sql) {
  return sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

for (const file of files) {
  test(`migration ${file} não usa palavra reservada como coluna sem aspas`, () => {
    const sql = stripComments(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    const colDef = new RegExp(`(^|[,(])\\s*([a-z_][a-z0-9_]*)\\s+(?:${COL_TYPE})\\b`, 'gi');
    const offenders = [];
    let m;
    while ((m = colDef.exec(sql)) !== null) {
      const ident = m[2].toLowerCase();
      if (RESERVED.has(ident)) offenders.push(ident);
    }
    assert.equal(offenders.length, 0,
      `Colunas com palavra reservada sem aspas em ${file}: ${offenders.join(', ')}. Renomeie ou use aspas duplas.`);
  });
}
