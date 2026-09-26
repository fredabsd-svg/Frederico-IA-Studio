// Rota GET /api/backup por HTTP de verdade, com `pg_dump` e `tar` FALSOS no
// PATH (scripts de shell) para simular falha no meio do empacotamento.
//
// O defeito (Regra 4.2 — sem sucesso falso): o código de saída do tar era
// ignorado depois que os primeiros bytes saíam. Um tar que morria no meio
// (disco cheio, arquivo sumindo) fechava a resposta normalmente e o navegador
// salvava um .tar.gz TRUNCADO como se fosse um backup bom. Agora a conexão é
// derrubada: o download falha de forma visível.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stamp = Date.now();
const ADMIN = `backup-admin-${stamp}`;
const COMUM = `backup-comum-${stamp}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-backup-http-'));
const binDir = path.join(scratch, 'bin');
fs.mkdirSync(binDir);
process.env.WORKSPACE_ROOT = path.join(scratch, 'workspaces');
fs.mkdirSync(process.env.WORKSPACE_ROOT);
process.env.DATA_DIR = path.join(scratch, 'data');
process.env.ADMIN_USER_ID = ADMIN;

// pg_dump falso: escreve um dump mínimo no caminho de `-f`.
fs.writeFileSync(path.join(binDir, 'pg_dump'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then shift; echo "-- dump" > "$1"; fi; shift; done\nexit 0\n', { mode: 0o755 });
function fakeTar(exitCode) {
  // Emite bytes (como um .tar.gz começando a sair) e termina com o código dado.
  fs.writeFileSync(path.join(binDir, 'tar'), `#!/bin/sh\nprintf 'BYTES-DO-PACOTE'\nexit ${exitCode}\n`, { mode: 0o755 });
}
const originalPath = process.env.PATH;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const backupRouter = (await import('./backup.js')).default;

let server, baseUrl;
let currentUser = ADMIN;

if (dbReady) {
  for (const id of [ADMIN, COMUM]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@t.local`, false, now(), now());
  }
  const app = express();
  app.use((req, _res, next) => { req.userId = currentUser; req.user = { id: currentUser, email: `${currentUser}@t.local` }; next(); });
  app.use('/api', backupRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  process.env.PATH = originalPath;
  server?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  if (!dbReady) return;
  for (const id of [ADMIN, COMUM]) {
    await db.prepare('DELETE FROM admin_audit WHERE user_id=?').run(id).catch(() => {});
    await db.prepare('DELETE FROM "user" WHERE id=?').run(id).catch(() => {});
  }
});

async function download() {
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  try {
    const res = await fetch(`${baseUrl}/api/backup`, { signal: AbortSignal.timeout(10_000) });
    try {
      const body = Buffer.from(await res.arrayBuffer()).toString('utf8');
      return { status: res.status, body, failed: false };
    } catch (err) {
      return { status: res.status, body: null, failed: true, error: err };
    }
  } finally {
    process.env.PATH = originalPath;
  }
}

test('usuário comum não baixa o backup (403)', { skip: needsDb }, async () => {
  currentUser = COMUM;
  try {
    fakeTar(0);
    const r = await download();
    assert.equal(r.status, 403);
  } finally {
    currentUser = ADMIN;
  }
});

test('tar concluído com sucesso: o download termina com o conteúdo completo', { skip: needsDb }, async () => {
  fakeTar(0);
  const r = await download();
  assert.equal(r.status, 200);
  assert.equal(r.failed, false);
  assert.equal(r.body, 'BYTES-DO-PACOTE');
});

test('SEM SUCESSO FALSO: tar que falha no meio DERRUBA o download em vez de entregar arquivo truncado', { skip: needsDb }, async () => {
  fakeTar(2);
  const r = await download();
  assert.equal(r.status, 200, 'os cabeçalhos já tinham saído quando o tar falhou');
  assert.equal(r.failed, true, 'a leitura do corpo precisa falhar — antes ela terminava "com sucesso"');
});
