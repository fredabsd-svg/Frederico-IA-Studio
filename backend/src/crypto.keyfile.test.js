import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Caminho self-hosted: SEM ENCRYPTION_KEY no ambiente, o módulo deve gerar uma
// chave mestra e persisti-la em DATA_DIR/encryption.key — para o usuário comum
// não precisar rodar `openssl`, e a chave ficar estável entre reinícios.
delete process.env.ENCRYPTION_KEY;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fred-keytest-'));
process.env.DATA_DIR = tmp;

const { encryptSecret, decryptSecret } = await import('./crypto.js');

test('gera e persiste a chave quando não há env nem arquivo', () => {
  const cifrado = encryptSecret('token-do-github');
  assert.equal(decryptSecret(cifrado), 'token-do-github', 'round-trip com a chave gerada');
  const keyFile = path.join(tmp, 'encryption.key');
  assert.ok(fs.existsSync(keyFile), 'deve ter criado o arquivo de chave');
  assert.match(fs.readFileSync(keyFile, 'utf8').trim(), /^[0-9a-f]{64}$/, 'arquivo com 64 hex');
});

test('reusa a mesma chave persistida (não regenera a cada uso)', () => {
  const a = encryptSecret('valor');
  assert.equal(decryptSecret(a), 'valor');
  // Uma nova cifra do mesmo texto ainda descriptografa (mesma chave em memória).
  assert.equal(decryptSecret(encryptSecret('valor')), 'valor');
});
