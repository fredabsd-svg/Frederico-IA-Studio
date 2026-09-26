// Quarentena de uploads (F-11): cobre as primitivas puras que o caminho
// completo precisa e, com PostgreSQL disponível, o re-escaneamento real contra
// a tabela `quarantined_uploads` (clamd e workspace injetados). Sem banco, os
// testes de re-escaneamento são pulados (mesma convenção dos demais).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quarantineDirFor, quarantineUploadedFile } from './clamav.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fred-quar-'));
}

test('quarantineDirFor aponta para uploads/.quarantine', () => {
  const d = quarantineDirFor('/workspace/uploads');
  assert.equal(d, path.join('/workspace/uploads', '.quarantine'));
});

test('quarantineUploadedFile move o arquivo e devolve o path relativo', () => {
  const dir = tmpdir();
  try {
    const uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const src = path.join(dir, 'req-original', '1717000000-abcdef');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'conteudo de teste');
    const rel = quarantineUploadedFile({
      conversationId: 'c1',
      userId: 'u1',
      srcPath: src,
      uploadsDir,
      name: 'planilha.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 100,
      hash: 'abc'
    });
    assert.ok(rel.startsWith('uploads/.quarantine/'), `path deve estar em .quarantine; recebi: ${rel}`);
    assert.ok(fs.existsSync(path.join(dir, rel)), 'o arquivo deve existir no destino da quarentena');
    assert.ok(!fs.existsSync(src), 'o staging original deve ter sido movido, não copiado');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quarantineUploadedFile cria o diretório .quarantine se não existir', () => {
  const dir = tmpdir();
  try {
    const uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    // NÃO cria .quarantine — quarantineUploadedFile deve fazer isso.
    const src = path.join(dir, 'staging', 'file');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'x');
    quarantineUploadedFile({ conversationId: 'c1', userId: 'u1', srcPath: src, uploadsDir, name: 'a.txt', mime: 'text/plain', size: 1, hash: 'h' });
    assert.ok(fs.existsSync(path.join(uploadsDir, '.quarantine')), '.quarantine deve ter sido criado');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quarantineUploadedFile saneia o nome original', () => {
  // Defesa contra path traversal no NOME. O `..` como literal é inofensivo
  // (é só dois pontos no nome do arquivo); o que importa é que NÃO exista
  // `/` separando componentes dentro do basename — sem isso, o arquivo
  // viraria subdiretórios e poderia escapar de `.quarantine/`.
  const dir = tmpdir();
  try {
    const uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const src = path.join(dir, 's', 'f');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'x');
    const rel = quarantineUploadedFile({
      conversationId: 'c1', userId: 'u1', srcPath: src, uploadsDir,
      name: '../../etc/passwd.txt',
      mime: 'text/plain', size: 1, hash: 'h'
    });
    const basename = rel.split('/').pop();
    assert.ok(!basename.includes('/'), `o basename saneado não pode ter "/"; recebi: ${basename}`);
    // Verifica que o arquivo FOI gravado dentro de .quarantine, não escapou.
    assert.ok(rel.includes('uploads/.quarantine/'), `path deve estar em .quarantine; recebi: ${rel}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Re-escaneamento (reprocessQuarantine) ----------------------------------
// O defeito: o caminho absoluto era montado com
// path.join(dirname(dirname(storage_path)), storage_path) — relativo ao cwd do
// processo, não ao workspace da conversa. O arquivo nunca era achado, o item
// virava 'stale' a cada tentativa e ficava preso na quarentena para sempre.

test('resolveQuarantinePaths resolve DENTRO do workspace e recusa fuga da quarentena', async () => {
  const { resolveQuarantinePaths } = await import('./clamav.js');
  const ws = { base: '/ws/users/u1/c1', uploads: '/ws/users/u1/c1/uploads' };
  const ok = resolveQuarantinePaths(ws, 'uploads/.quarantine/1717_AbC-d_e_planilha.xlsx');
  assert.equal(ok.full, '/ws/users/u1/c1/uploads/.quarantine/1717_AbC-d_e_planilha.xlsx');
  // Liberado com o MESMO nome opaco (sem "limpar" o prefixo, que podia colidir).
  assert.equal(ok.target, '/ws/users/u1/c1/uploads/1717_AbC-d_e_planilha.xlsx');
  assert.equal(ok.relTarget, 'uploads/1717_AbC-d_e_planilha.xlsx');
  for (const ruim of ['uploads/.quarantine/../../../etc/passwd', 'uploads/arquivo.pdf', '../x', '/etc/passwd', '', 'uploads/.quarantine/']) {
    assert.equal(resolveQuarantinePaths(ws, ruim), null, `deveria recusar: ${ruim}`);
  }
});

const { db, now } = await import('./db.js');
let dbReady = true;
try { await db.prepare('SELECT 1 AS ok').get(); } catch { dbReady = false; }
if (dbReady) { const { runMigrations } = await import('./migrate.js'); await runMigrations(); }
const needsDb = dbReady ? false : 'requer PostgreSQL (DATABASE_URL)';

test('item limpo sai da quarentena para uploads/, atualiza files.path e fica "cleared"', { skip: needsDb }, async () => {
  const { reprocessQuarantine } = await import('./clamav.js');
  const dir = tmpdir();
  const stamp = Date.now();
  const id = `quar-limpo-${stamp}`;
  const conv = `quar-conv-${stamp}`;
  const ws = { base: path.join(dir, 'c1'), uploads: path.join(dir, 'c1', 'uploads') };
  const name = `${stamp}_Ab-C_d_relatorio.pdf`;
  fs.mkdirSync(path.join(ws.uploads, '.quarantine'), { recursive: true });
  fs.writeFileSync(path.join(ws.uploads, '.quarantine', name), '%PDF');
  const rel = `uploads/.quarantine/${name}`;
  const user = `u-quar-${stamp}`;
  try {
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)').run(user, user, `${user}@t.local`, false, now(), now());
    await db.prepare('INSERT INTO conversations (id,user_id,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(conv, user, 't', 'm', now(), now());
    await db.prepare('INSERT INTO files (id,conversation_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?)').run(id, conv, 'upload', 'relatorio.pdf', rel, 4, now());
    await db.prepare("INSERT INTO quarantined_uploads (id,conversation_id,user_id,storage_path,original_name,size,status,quarantined_at) VALUES (?,?,?,?,?,?,'pending',?)")
      .run(id, conv, 'u-quar', rel, 'relatorio.pdf', 4, now());
    const scanned = [];
    const result = await reprocessQuarantine({
      enabled: true,
      listReady: async () => db.prepare('SELECT * FROM quarantined_uploads WHERE id=?').all(id),
      workspaceOf: async () => ws,
      scan: async (full) => { scanned.push(full); return { clean: true }; }
    });
    assert.equal(result.cleared, 1, JSON.stringify(result));
    assert.deepEqual(scanned, [path.join(ws.uploads, '.quarantine', name)], 'escaneou o arquivo DO WORKSPACE');
    assert.ok(fs.existsSync(path.join(ws.uploads, name)), 'o arquivo foi liberado para uploads/');
    assert.ok(!fs.existsSync(path.join(ws.uploads, '.quarantine', name)));
    assert.equal((await db.prepare('SELECT path FROM files WHERE id=?').get(id)).path, `uploads/${name}`);
    assert.equal((await db.prepare('SELECT status FROM quarantined_uploads WHERE id=?').get(id)).status, 'cleared');
  } finally {
    await db.prepare('DELETE FROM quarantined_uploads WHERE id=?').run(id).catch(() => {});
    await db.prepare('DELETE FROM files WHERE id=?').run(id).catch(() => {});
    await db.prepare('DELETE FROM conversations WHERE id=?').run(conv).catch(() => {});
    await db.prepare('DELETE FROM "user" WHERE id=?').run(user).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('item infectado é apagado e marcado; caminho adulterado nunca é escaneado', { skip: needsDb }, async () => {
  const { reprocessQuarantine } = await import('./clamav.js');
  const dir = tmpdir();
  const stamp = Date.now();
  const infectado = `quar-virus-${stamp}`;
  const adulterado = `quar-fuga-${stamp}`;
  const ws = { base: path.join(dir, 'c1'), uploads: path.join(dir, 'c1', 'uploads') };
  fs.mkdirSync(path.join(ws.uploads, '.quarantine'), { recursive: true });
  fs.writeFileSync(path.join(ws.uploads, '.quarantine', 'v.exe'), 'X5O!');
  try {
    for (const [id, rel] of [[infectado, 'uploads/.quarantine/v.exe'], [adulterado, 'uploads/.quarantine/../../../../etc/passwd']]) {
      await db.prepare("INSERT INTO quarantined_uploads (id,conversation_id,user_id,storage_path,original_name,size,status,quarantined_at) VALUES (?,?,?,?,?,?,'pending',?)")
        .run(id, 'c1', 'u-quar', rel, 'x', 1, now());
    }
    const scanned = [];
    const result = await reprocessQuarantine({
      enabled: true,
      listReady: async () => db.prepare('SELECT * FROM quarantined_uploads WHERE id IN (?,?) ORDER BY id').all(infectado, adulterado),
      workspaceOf: async () => ws,
      scan: async (full) => { scanned.push(full); return { clean: false, virus: 'Eicar-Test' }; }
    });
    assert.equal(result.infected, 1);
    assert.equal(result.stale, 1);
    assert.ok(scanned.every(full => full.startsWith(path.join(ws.uploads, '.quarantine'))), 'nada fora da quarentena foi lido');
    assert.ok(!fs.existsSync(path.join(ws.uploads, '.quarantine', 'v.exe')), 'o infectado foi apagado');
    assert.equal((await db.prepare('SELECT status, virus_name FROM quarantined_uploads WHERE id=?').get(infectado)).virus_name, 'Eicar-Test');
    assert.equal((await db.prepare('SELECT status FROM quarantined_uploads WHERE id=?').get(adulterado)).status, 'stale');
  } finally {
    await db.prepare('DELETE FROM quarantined_uploads WHERE id IN (?,?)').run(infectado, adulterado).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
