// Tetos do multer por HTTP de verdade: arquivo grande demais, arquivos demais
// e campo inesperado. Antes, o MulterError caía no tratador global e virava
// 500 "Erro interno" — o cliente não sabia que era LIMITE — e o parcial gravado
// em disco ficava no staging até a varredura horária. Agora (uploads.js →
// uploadErrorHandler, montado no server.js antes do tratador global):
// 413 para limite de tamanho/quantidade de partes, 400 para pedido malformado,
// e o staging é sempre removido.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-upload-lim-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-upload-lim-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_MAX_FILE_MB = '1';
process.env.UPLOAD_MAX_FILES = '2';
process.env.UPLOAD_MAX_REQUEST_MB = '20';
delete process.env.CLAMAV_HOST;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const conversationsRouter = (await import('./conversations.js')).default;
const { uploadErrorHandler, uploadErrorResponse } = await import('../uploads.js');
const multer = (await import('multer')).default;

const USER = `up-lim-${Date.now()}`;
const CONV = `conversa-lim-${Date.now()}`;
let server, baseUrl;

if (dbReady) {
  await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .run(USER, USER, `${USER}@t.local`, false, now(), now());
  const app = express();
  app.use((req, _res, next) => { req.userId = USER; req.user = { id: USER }; next(); });
  app.use('/api', conversationsRouter);
  // Mesma ordem do server.js: o mapeamento do multer antes do tratador global.
  app.use(uploadErrorHandler);
  app.use((err, _req, res, _next) => { res.status(500).json({ error: 'Erro interno do servidor.' }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  await db.prepare('DELETE FROM files WHERE conversation_id=?').run(CONV).catch(() => {});
  await db.prepare('DELETE FROM conversations WHERE id=?').run(CONV).catch(() => {});
  await db.prepare('DELETE FROM "user" WHERE id=?').run(USER).catch(() => {});
});

function stagingLeft() {
  const tmpRoot = path.join(dataDir, 'tmp-uploads');
  return fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : [];
}

async function send(parts, field = 'files') {
  const form = new FormData();
  for (const [name, content] of parts) form.append(field, new Blob([content]), name);
  const res = await fetch(`${baseUrl}/api/conversations/${CONV}/upload`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('uploadErrorResponse: tamanho → 413, quantidade/campo → 400, outros erros → null', () => {
  assert.equal(uploadErrorResponse(new multer.MulterError('LIMIT_FILE_SIZE')).status, 413);
  assert.equal(uploadErrorResponse(new multer.MulterError('LIMIT_PART_COUNT')).status, 413);
  assert.equal(uploadErrorResponse(new multer.MulterError('LIMIT_FILE_COUNT')).status, 400);
  assert.equal(uploadErrorResponse(new multer.MulterError('LIMIT_UNEXPECTED_FILE')).status, 400);
  assert.equal(uploadErrorResponse(new Error('qualquer')), null);
  assert.equal(uploadErrorResponse(null), null);
});

test('arquivo acima do teto por arquivo é 413 (não 500) e o parcial some do disco', { skip: needsDb }, async () => {
  const r = await send([['grande.bin', 'x'.repeat(1.5 * 1024 * 1024)]]);
  assert.equal(r.status, 413);
  assert.equal(r.body.code, 'upload_limit_file_size');
  assert.match(r.body.error, /1 MB/);
  assert.deepEqual(stagingLeft(), [], 'o parcial gravado antes do corte foi removido');
});

test('arquivos demais é 400 com mensagem útil e sem temporários', { skip: needsDb }, async () => {
  const r = await send([['a.txt', 'a'], ['b.txt', 'b'], ['c.txt', 'c']]);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'upload_limit_file_count');
  assert.deepEqual(stagingLeft(), []);
});

test('campo de arquivo inesperado é 400 (não 500)', { skip: needsDb }, async () => {
  const r = await send([['a.txt', 'a']], 'outro_campo');
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'upload_limit_unexpected_file');
  assert.deepEqual(stagingLeft(), []);
});

test('envio dentro dos tetos continua funcionando', { skip: needsDb }, async () => {
  const r = await send([['ok.txt', 'conteudo']]);
  assert.equal(r.status, 200);
  assert.equal(r.body.files.length, 1);
});
