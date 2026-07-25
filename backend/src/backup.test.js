// Backup e restauração — o que o pacote precisa levar para ser restaurável.
//
// O caso que motivou estes testes: o backup antigo (dump do Postgres +
// workspaces) NÃO levava DATA_DIR/encryption.key. Restaurado num host novo, o
// banco voltava íntegro e toda chave de API/token de conector ficava ilegível,
// porque a chave mestra que os decifra tinha ficado para trás. O último teste
// reproduz exatamente esse ciclo: cifra → "faz backup" → restaura noutro
// DATA_DIR → decifra.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  BACKUP_FORMAT,
  buildManifest,
  encryptionKeySource,
  keyFilePath,
  sha256File,
  verifyExtractedBackup,
  acquireBackupLock,
  isBackupRunning
} = await import('./backup.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('a origem da chave mestra é detectada corretamente', () => {
  const dir = tmpdir('fred-backup-src-');
  assert.equal(encryptionKeySource({ env: '', dataDir: dir }), 'none');
  fs.writeFileSync(keyFilePath(dir), `${'a'.repeat(64)}\n`);
  assert.equal(encryptionKeySource({ env: '', dataDir: dir }), 'file');
  assert.equal(encryptionKeySource({ env: 'b'.repeat(64), dataDir: dir }), 'env',
    'a env manda: a chave NÃO vem do arquivo (e não entra no pacote)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('o manifesto avisa quando a chave mestra FICOU de fora (origem env)', () => {
  const manifest = buildManifest({
    createdAt: '2026-07-25T10:00:00.000Z',
    keySource: 'env',
    schemaVersion: '020_admin_roles_audit.sql',
    appliedMigrations: 20,
    entries: [{ name: 'db.sql', role: 'postgres-dump', bytes: 10, sha256: 'abc' }]
  });
  assert.equal(manifest.formato, BACKUP_FORMAT);
  assert.equal(manifest.chave_mestra.origem, 'env');
  assert.equal(manifest.chave_mestra.incluida_no_pacote, false);
  assert.match(manifest.chave_mestra.aviso, /irrecuperáveis/i);
  assert.equal(manifest.schema.ultima_migracao, '020_admin_roles_audit.sql');
});

test('o manifesto marca o pacote como segredo quando a chave VAI junto', () => {
  const manifest = buildManifest({
    createdAt: '2026-07-25T10:00:00.000Z',
    keySource: 'file',
    entries: [
      { name: 'db.sql', role: 'postgres-dump', bytes: 10, sha256: 'abc' },
      { name: 'encryption.key', role: 'encryption-key', bytes: 65, sha256: 'def' }
    ]
  });
  assert.equal(manifest.chave_mestra.incluida_no_pacote, true);
  assert.match(manifest.chave_mestra.aviso, /trate-o como segredo/i);
});

test('a verificação do pacote extraído detecta arquivo alterado ou ausente', () => {
  const dir = tmpdir('fred-backup-verify-');
  fs.writeFileSync(path.join(dir, 'db.sql'), 'CREATE TABLE t(a int);');
  const manifest = buildManifest({
    createdAt: '2026-07-25T10:00:00.000Z',
    keySource: 'none',
    entries: [
      { name: 'db.sql', role: 'postgres-dump', bytes: 22, sha256: sha256File(path.join(dir, 'db.sql')) },
      { name: 'workspaces/', role: 'workspaces' }
    ]
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

  assert.equal(verifyExtractedBackup(dir).ok, true, 'pacote íntegro passa');

  fs.writeFileSync(path.join(dir, 'db.sql'), 'CONTEÚDO ADULTERADO');
  const tampered = verifyExtractedBackup(dir);
  assert.equal(tampered.ok, false);
  assert.match(tampered.problems.join(' '), /checksum diferente/);

  fs.rmSync(path.join(dir, 'db.sql'));
  assert.match(verifyExtractedBackup(dir).problems.join(' '), /ausente/);

  fs.rmSync(path.join(dir, 'manifest.json'));
  assert.match(verifyExtractedBackup(dir).error, /manifest\.json ausente/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dois backups simultâneos não são permitidos (trava)', () => {
  assert.equal(isBackupRunning(), false);
  const release = acquireBackupLock();
  assert.ok(release, 'o primeiro adquire a trava');
  assert.equal(acquireBackupLock(), null, 'o segundo é recusado');
  release();
  release(); // idempotente
  assert.equal(isBackupRunning(), false);
  const again = acquireBackupLock();
  assert.ok(again, 'depois de liberada, um novo backup pode começar');
  again();
});

test('CICLO REAL: segredo cifrado antes do backup é decifrado depois da restauração', async () => {
  // 1) Host original: sem ENCRYPTION_KEY no ambiente, a chave é gerada em
  //    DATA_DIR/encryption.key e cifra o token do usuário.
  const original = tmpdir('fred-restore-origem-');
  delete process.env.ENCRYPTION_KEY;
  process.env.DATA_DIR = original;
  const cryptoOrigem = await import(`./crypto.js?host=origem-${Date.now()}`);
  const cifrado = cryptoOrigem.encryptSecret('ghp_token_do_usuario_123');
  assert.equal(cryptoOrigem.decryptSecret(cifrado), 'ghp_token_do_usuario_123');
  assert.ok(fs.existsSync(keyFilePath(original)), 'a chave mestra existe no host original');
  assert.equal(encryptionKeySource({ env: '', dataDir: original }), 'file',
    'a chave vem de arquivo → o backup TEM de incluí-la');

  // 2) Host novo, SEM a chave (o que o backup antigo produzia): o segredo é
  //    ilegível — decryptSecret devolve null em vez do token.
  const semChave = tmpdir('fred-restore-sem-chave-');
  process.env.DATA_DIR = semChave;
  const cryptoSemChave = await import(`./crypto.js?host=sem-chave-${Date.now()}`);
  assert.equal(cryptoSemChave.decryptSecret(cifrado), null,
    'sem a chave mestra restaurada, o segredo do banco fica irrecuperável');

  // 3) Host novo COM a chave restaurada do pacote: o mesmo segredo volta.
  const restaurado = tmpdir('fred-restore-com-chave-');
  fs.copyFileSync(keyFilePath(original), keyFilePath(restaurado));
  process.env.DATA_DIR = restaurado;
  const cryptoRestaurado = await import(`./crypto.js?host=restaurado-${Date.now()}`);
  assert.equal(cryptoRestaurado.decryptSecret(cifrado), 'ghp_token_do_usuario_123',
    'com encryption.key no pacote, a restauração preserva os segredos cifrados');

  for (const d of [original, semChave, restaurado]) fs.rmSync(d, { recursive: true, force: true });
});
