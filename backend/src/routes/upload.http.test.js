// Teste INTEGRADO de upload: rota Express real + autenticação simulada + banco
// PostgreSQL real + corpo multipart de verdade. Não existia nada assim — os
// testes de upload eram todos de função isolada, então a rota inteira (portão
// de concorrência, multer em disco, cota, escrita no banco, limpeza) nunca era
// exercitada junta.
//
// Sem DATABASE_URL, é pulado (mesma convenção dos demais testes de banco).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-upload-http-ws-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-upload-http-data-'));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_MAX_REQUEST_MB = '5';
process.env.UPLOAD_MAX_CONCURRENT_PER_USER = '1';
delete process.env.CLAMAV_HOST;

const { db, now } = await import('../db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('../migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

const express = (await import('express')).default;
const conversationsRouter = (await import('./conversations.js')).default;

const stamp = Date.now();
const USER_A = `up-a-${stamp}`;
const USER_B = `up-b-${stamp}`;
const CONV = `conversa-upload-${stamp}`;

let server, baseUrl;
let currentUser = USER_A;

if (dbReady) {
  for (const id of [USER_A, USER_B]) {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
      .run(id, id, `${id}@teste.local`, false, now(), now());
  }
  const app = express();
  // Autenticação simulada: o portão real (requireAuth) já é exercitado por
  // outros caminhos; aqui o que importa é a rota funcionar com req.userId.
  app.use((req, _res, next) => { req.userId = currentUser; req.user = { id: currentUser, email: `${currentUser}@teste.local` }; next(); });
  app.use('/api', conversationsRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  server?.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (!dbReady) return;
  for (const id of [USER_A, USER_B]) {
    try { await db.prepare('DELETE FROM "user" WHERE id=?').run(id); } catch {}
  }
});

function multipart(files) {
  const form = new FormData();
  for (const [name, content] of files) form.append('files', new Blob([content]), name);
  return form;
}

async function upload(conversationId, files, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/upload`, {
    method: 'POST',
    body: multipart(files),
    headers: extraHeaders
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('upload real grava o arquivo no workspace do dono e registra no banco', { skip: needsDb }, async () => {
  const r = await upload(CONV, [['Razão Social.pdf', '%PDF-conteudo-do-a']]);
  assert.equal(r.status, 200);
  assert.equal(r.body.files.length, 1);
  assert.equal(r.body.files[0].name, 'Razão Social.pdf', 'o nome original com acento é preservado');
  // Sem antivírus configurado, o lote NÃO pode se dizer verificado.
  assert.equal(r.body.scanned, false);
  assert.equal(r.body.scanStatus, 'sem-antivirus');

  const stored = path.join(workspaceRoot, 'users', USER_A, CONV, r.body.files[0].path);
  assert.equal(fs.readFileSync(stored, 'utf8'), '%PDF-conteudo-do-a');

  const row = await db.prepare('SELECT name, size, hash FROM files WHERE conversation_id=?').get(CONV);
  assert.equal(row.name, 'Razão Social.pdf');
  assert.equal(Number(row.size), Buffer.byteLength('%PDF-conteudo-do-a'));
  assert.match(row.hash, /^[0-9a-f]{64}$/, 'o hash de conteúdo foi calculado por streaming');
});

test('ISOLAMENTO: o usuário B não recebe nem alcança o arquivo do usuário A', { skip: needsDb }, async () => {
  currentUser = USER_B;
  try {
    // Mesma conversa, outro dono: a conversa é de A, então B leva 404.
    const negado = await upload(CONV, [['tentativa.txt', 'x']]);
    assert.equal(negado.status, 404);
    // O arquivo de A continua onde estava e nenhum diretório de B foi criado
    // com o conteúdo dele.
    const dirB = path.join(workspaceRoot, 'users', USER_B, CONV);
    const arquivosDeB = fs.existsSync(dirB) ? fs.readdirSync(path.join(dirB, 'uploads')) : [];
    assert.deepEqual(arquivosDeB, [], 'B não enxerga nem herda o upload de A');
  } finally {
    currentUser = USER_A;
  }
});

test('nenhum temporário sobra em disco depois dos envios', { skip: needsDb }, async () => {
  const tmpRoot = path.join(dataDir, 'tmp-uploads');
  const restos = fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : [];
  assert.deepEqual(restos, [], `staging deveria estar vazio, mas sobrou: ${restos.join(', ')}`);
});

test('lote acima do teto por requisição é recusado com 413', { skip: needsDb }, async () => {
  // UPLOAD_MAX_REQUEST_MB=5 → 3 arquivos de 2 MB estouram o total.
  const dois = 'x'.repeat(2 * 1024 * 1024);
  const r = await upload(CONV, [['a.bin', dois], ['b.bin', dois], ['c.bin', dois]]);
  assert.equal(r.status, 413);
  assert.equal(r.body.code, 'upload_request_too_large');
  const tmpRoot = path.join(dataDir, 'tmp-uploads');
  assert.deepEqual(fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : [], [],
    'o lote recusado não deixa arquivos temporários para trás');
});

test('Content-Length exagerado é recusado ANTES de o corpo ser lido', { skip: needsDb }, async () => {
  // Socket cru de propósito: o cliente HTTP do Node se recusa a mandar um
  // Content-Length que não bate com o corpo, e é exatamente esse cenário —
  // "o cliente anuncia 900 MB" — que o portão precisa cortar sem gravar nada.
  const net = await import('node:net');
  const { port } = server.address();
  const status = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `POST /api/conversations/${CONV}/upload HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Content-Type: multipart/form-data; boundary=xyz\r\n' +
        `Content-Length: ${900 * 1024 * 1024}\r\n` +
        'Connection: close\r\n\r\n'
      );
      // Não enviamos o corpo: se o servidor esperasse por ele, o teste estouraria
      // o timeout em vez de receber a recusa imediata.
    });
    let buf = '';
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error('sem resposta: o servidor esperou o corpo')); });
    socket.on('data', d => {
      buf += d.toString('utf8');
      const line = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (line) { socket.destroy(); resolve(Number(line[1])); }
    });
    socket.on('error', reject);
  });
  assert.equal(status, 413, 'o servidor recusa pelo Content-Length declarado, sem ler o corpo');
});
