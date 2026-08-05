// Quarentena de uploads (F-11): cobre as primitivas puras que o caminho
// completo precisa, sem exigir DB real. As integrações com a tabela
// `quarantined_uploads` (insert/update/select) ficam cobertas indiretamente
// pelo erro silencioso — os call sites tratam DB indisponível como "fila
// vazia" e o sistema continua funcionando.
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
