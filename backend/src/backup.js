// Backup completo do Frederico AI Studio — a PARTE PURA (testável) do processo.
//
// O que o backup antigo NÃO incluía, e por que isso quebrava a restauração:
// as chaves de API e os tokens dos conectores ficam CIFRADOS no banco com a
// chave mestra (AES-256-GCM). Quando não há ENCRYPTION_KEY no ambiente, essa
// chave é gerada e guardada em DATA_DIR/encryption.key — um arquivo que o
// backup (dump do Postgres + workspaces) simplesmente ignorava. Restaurar esse
// backup num host novo devolvia o banco intacto e TODOS os segredos ilegíveis.
//
// Agora o pacote leva:
//   * manifest.json  — versão do backup, data, versão do schema, o que está
//                      incluído, checksums e a ORIGEM da chave mestra;
//   * encryption.key — apenas quando a chave vive em arquivo (self-hosted).
//                      Se ela vem de ENCRYPTION_KEY (env/secret manager), o
//                      segredo NÃO é copiado para o pacote: quem o definiu já
//                      o controla, e escrevê-lo num .tar.gz que trafega por
//                      download seria vazá-lo. O manifesto avisa em alto e bom
//                      som que o backup depende dela.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_FORMAT = 'frederico-ia-studio/backup';
export const BACKUP_VERSION = 1;

export function keyFilePath(dataDir = process.env.DATA_DIR || './data') {
  return path.join(path.resolve(dataDir), 'encryption.key');
}

// De onde vem a chave mestra deste processo, do ponto de vista do backup.
//   'env'   → definida em ENCRYPTION_KEY: NÃO entra no pacote (mas é essencial).
//   'file'  → DATA_DIR/encryption.key: entra no pacote.
//   'none'  → não existe ainda (instalação que nunca cifrou nada).
export function encryptionKeySource({ env = process.env.ENCRYPTION_KEY, dataDir } = {}) {
  if (String(env || '').trim()) return 'env';
  return fs.existsSync(keyFilePath(dataDir)) ? 'file' : 'none';
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// Monta o manifesto. PURO: recebe os fatos já apurados e devolve o objeto.
export function buildManifest({
  createdAt,
  schemaVersion = null,
  appliedMigrations = 0,
  appVersion = null,
  keySource = 'none',
  entries = []
}) {
  const includesKey = entries.some(e => e.role === 'encryption-key');
  return {
    formato: BACKUP_FORMAT,
    versao_backup: BACKUP_VERSION,
    criado_em: createdAt,
    versao_app: appVersion,
    schema: { ultima_migracao: schemaVersion, migracoes_aplicadas: appliedMigrations },
    chave_mestra: {
      origem: keySource,
      incluida_no_pacote: includesKey,
      aviso: includesKey
        ? 'Este pacote CONTÉM a chave mestra (encryption.key). Ele descriptografa as chaves de IA e os tokens do banco: trate-o como segredo, guarde cifrado e restrinja o acesso.'
        : (keySource === 'env'
          ? 'A chave mestra vem da variável de ambiente ENCRYPTION_KEY e NÃO foi incluída neste pacote. Guarde-a separadamente: sem ela, as chaves de IA e os tokens do banco restaurado ficam irrecuperáveis.'
          : 'Nenhuma chave mestra existia no momento do backup (nada cifrado a preservar).')
    },
    conteudo: entries.map(e => ({ arquivo: e.name, papel: e.role, bytes: e.bytes ?? null, sha256: e.sha256 ?? null })),
    restauracao: 'Ver docs/BACKUP_RESTORE.md'
  };
}

// Verificador do pacote restaurado: confere os checksums do manifesto contra os
// arquivos extraídos. Usado pelo procedimento de restauração e pelos testes.
export function verifyExtractedBackup(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, error: 'manifest.json ausente — pacote antigo ou incompleto.' };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, error: `manifest.json ilegível: ${e.message}` }; }
  if (manifest.formato !== BACKUP_FORMAT) return { ok: false, error: `formato desconhecido: ${manifest.formato}` };
  const problems = [];
  for (const item of manifest.conteudo || []) {
    if (!item.sha256) continue; // diretórios (workspaces) não têm checksum
    const full = path.join(dir, item.arquivo);
    if (!fs.existsSync(full)) { problems.push(`${item.arquivo}: ausente`); continue; }
    const actual = sha256File(full);
    if (actual !== item.sha256) problems.push(`${item.arquivo}: checksum diferente`);
  }
  return { ok: problems.length === 0, manifest, problems };
}

// ---- Trava de concorrência (um backup por vez) ------------------------------
// Dois backups simultâneos disputavam o MESMO arquivo /tmp/frederico-db-<data>.sql:
// o segundo pg_dump sobrescrevia o dump do primeiro no meio do tar, e o
// download saía com um dump truncado ou misturado — sem nenhum aviso.
let running = false;
export function acquireBackupLock() {
  if (running) return null;
  running = true;
  let released = false;
  return () => { if (!released) { released = true; running = false; } };
}
export function isBackupRunning() { return running; }
