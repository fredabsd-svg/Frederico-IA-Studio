// Política de uploads: memória, tetos, concorrência, cota e limpeza.
//
// Contexto do problema corrigido: com multer.memoryStorage() e limites de 50 MB
// × 20 arquivos, UMA requisição podia colocar ~1 GB em Buffer na RAM do Node —
// e o hash e o antivírus faziam mais passadas sobre os mesmos bytes. Não havia
// teto total por requisição, cota por usuário nem limite de envios simultâneos.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-uploads-'));
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_MAX_REQUEST_MB = '10';
process.env.UPLOAD_MAX_CONCURRENT_PER_USER = '2';
process.env.UPLOAD_USER_QUOTA_MB = '1';

const {
  UPLOAD_LIMITS,
  upload,
  uploadTmpRoot,
  cleanupRequestUploads,
  totalUploadBytes,
  rejectOversizedRequest,
  acquireUploadSlot,
  uploadSlotsInUse,
  directorySize,
  quotaVerdict,
  hashFileStreamSync,
  commitUploadedFile,
  sweepStaleUploadTemps
} = await import('./uploads.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const MB = 1024 * 1024;

test('o armazenamento é em DISCO, nunca em memória', () => {
  // A regressão que este teste trava: voltar para memoryStorage(). O storage do
  // multer em disco expõe getDestination/_handleFile e NÃO acumula .buffer.
  const storage = upload.storage;
  assert.ok(storage, 'o multer precisa de um storage explícito');
  assert.equal(typeof storage.getDestination, 'function',
    'diskStorage expõe getDestination — memoryStorage não');
});

test('os tetos vêm do ambiente e têm padrões conservadores', () => {
  assert.equal(UPLOAD_LIMITS.maxRequestBytes, 10 * MB);
  assert.equal(UPLOAD_LIMITS.maxConcurrentPerUser, 2);
  assert.equal(UPLOAD_LIMITS.userQuotaBytes, 1 * MB);
  assert.equal(UPLOAD_LIMITS.maxFileBytes, 50 * MB);
});

test('requisição grande demais é recusada pelo Content-Length, antes de ler o corpo', () => {
  const respostas = [];
  const res = { status(c) { respostas.push(c); return this; }, json(b) { respostas.push(b); return this; } };
  const grande = { headers: { 'content-length': String(500 * MB) } };
  assert.equal(rejectOversizedRequest(grande, res), true);
  assert.equal(respostas[0], 413);
  assert.equal(respostas[1].code, 'upload_request_too_large');

  const pequena = { headers: { 'content-length': String(2 * MB) } };
  assert.equal(rejectOversizedRequest(pequena, { status() { throw new Error('não deveria recusar'); } }), false);
});

test('o total da requisição soma todos os arquivos do lote', () => {
  assert.equal(totalUploadBytes([{ size: 10 }, { size: 5 }, {}]), 15);
  assert.equal(totalUploadBytes(), 0);
});

test('há teto de envios SIMULTÂNEOS por usuário (backpressure, não OOM)', () => {
  const a = acquireUploadSlot('u1');
  const b = acquireUploadSlot('u1');
  assert.ok(a && b);
  assert.equal(uploadSlotsInUse('u1'), 2);
  assert.equal(acquireUploadSlot('u1'), null, 'o terceiro envio simultâneo é recusado');
  // Outro usuário não é afetado pelo teto de u1.
  const outro = acquireUploadSlot('u2');
  assert.ok(outro, 'o limite é POR usuário');
  a();
  assert.ok(acquireUploadSlot('u1'), 'liberada uma vaga, o próximo entra');
  b(); b(); outro();
});

test('a cota por usuário bloqueia o lote que estouraria o limite', () => {
  assert.equal(quotaVerdict({ usedBytes: 0, incomingBytes: 500 * 1024, quotaBytes: 1 * MB }).ok, true);
  const cheio = quotaVerdict({ usedBytes: 900 * 1024, incomingBytes: 500 * 1024, quotaBytes: 1 * MB });
  assert.equal(cheio.ok, false);
  assert.equal(cheio.code, 'upload_quota_exceeded');
  assert.match(cheio.error, /cota de armazenamento/i);
  assert.equal(quotaVerdict({ usedBytes: 10 ** 9, incomingBytes: 10 ** 9, quotaBytes: 0 }).ok, true, 'cota 0 = sem cota');
});

test('directorySize soma a árvore inteira do usuário', () => {
  const dir = path.join(dataDir, 'arvore');
  fs.mkdirSync(path.join(dir, 'conversa-a', 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'conversa-b', 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversa-a', 'uploads', 'x.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, 'conversa-b', 'outputs', 'y.bin'), Buffer.alloc(2000));
  assert.equal(directorySize(dir), 3000);
  assert.equal(directorySize(path.join(dataDir, 'nao-existe')), 0);
});

test('o hash é por streaming e bate com o conteúdo real', async () => {
  const file = path.join(dataDir, 'grande.bin');
  fs.writeFileSync(file, Buffer.alloc(300 * 1024, 7)); // maior que o bloco de 64 KB
  const nosso = hashFileStreamSync(file);
  const { createHash } = await import('node:crypto');
  const referencia = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(nosso, referencia);
});

test('commitUploadedFile move o temporário para o destino final', () => {
  const temp = path.join(dataDir, 'temp-abc');
  const alvo = path.join(dataDir, 'destino', 'uploads', 'relatorio.pdf');
  fs.writeFileSync(temp, '%PDF-conteudo');
  const size = commitUploadedFile(temp, alvo);
  assert.equal(size, fs.statSync(alvo).size);
  assert.equal(fs.readFileSync(alvo, 'utf8'), '%PDF-conteudo');
  assert.ok(!fs.existsSync(temp), 'o temporário não fica para trás');
});

test('cleanupRequestUploads remove o staging inteiro, inclusive parciais', () => {
  const stage = fs.mkdtempSync(path.join(uploadTmpRoot === dataDir ? os.tmpdir() : ensureDir(uploadTmpRoot), 'req-'));
  fs.writeFileSync(path.join(stage, 'parcial-1'), 'envio interrompido no meio');
  const req = { _uploadStage: stage };
  cleanupRequestUploads(req);
  assert.ok(!fs.existsSync(stage), 'nenhum resto de um envio abortado');
  cleanupRequestUploads(req); // idempotente
  cleanupRequestUploads({});
});

test('a varredura recolhe temporários abandonados por uma queda do processo', () => {
  const stage = fs.mkdtempSync(path.join(ensureDir(uploadTmpRoot), 'req-'));
  fs.writeFileSync(path.join(stage, 'orfao'), 'x');
  // Nada é removido dentro da janela de carência...
  assert.equal(sweepStaleUploadTemps({ olderThanMs: 60 * 60 * 1000 }).removed, 0);
  // ...e é removido quando ela passa.
  assert.equal(sweepStaleUploadTemps({ olderThanMs: 0, nowMs: Date.now() + 1000 }).removed >= 1, true);
  assert.ok(!fs.existsSync(stage));
});

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
