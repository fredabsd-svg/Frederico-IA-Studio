// Rotas de backup completo (banco + workspaces + chave mestra + manifesto).
//
// Ver src/backup.js para o "porquê" de cada peça. Aqui fica só a orquestração:
// trava, diretório temporário próprio, pg_dump, cópia da chave, manifesto,
// tar e limpeza garantida.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { db } from '../db.js';
import { makeRouter, requireAdmin, recordAdminAction } from './helpers.js';
import { buildManifest, encryptionKeySource, keyFilePath, sha256File, acquireBackupLock } from '../backup.js';

const router = makeRouter();

async function schemaInfo() {
  try {
    const rows = await db.prepare('SELECT name FROM schema_migrations ORDER BY name ASC').all();
    return { schemaVersion: rows.length ? rows[rows.length - 1].name : null, appliedMigrations: rows.length };
  } catch {
    return { schemaVersion: null, appliedMigrations: 0 };
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr?.on('data', d => { stderr += String(d).slice(0, 2000); });
    child.on('error', (err) => resolve({ code: -1, error: err.message }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

// Backup completo (banco + workspaces + chave mestra) num .tar.gz para download.
router.get('/backup', async (req, res) => {
  // Backup = banco INTEIRO + todos os workspaces + a chave que decifra os
  // segredos (dados de TODOS os usuários). Só o administrador pode baixar.
  if (!await requireAdmin(req, res)) return;

  const release = acquireBackupLock();
  if (!release) {
    return res.status(409).json({ error: 'Já existe um backup em andamento. Aguarde ele terminar antes de iniciar outro.' });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const wsRoot = path.resolve(process.env.WORKSPACE_ROOT || './workspaces');
  const dbUrl = process.env.DATABASE_URL || 'postgres://studio:studio@postgres:5432/studio';
  // Diretório temporário EXCLUSIVO deste backup — nunca um caminho fixo em /tmp
  // (dois backups simultâneos se sobrescreviam) e sempre removido no finally.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'frederico-backup-'));
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    release();
  };

  try {
    const entries = [];

    // 1) Dump do PostgreSQL.
    const dumpName = `frederico-db-${stamp}.sql`;
    const dumpPath = path.join(stage, dumpName);
    const dump = await run('pg_dump', ['--no-owner', '--no-privileges', '-f', dumpPath, dbUrl]);
    if (dump.code !== 0 || !fs.existsSync(dumpPath)) {
      cleanup();
      return res.status(500).json({ error: dump.error ? 'Backup do banco falhou (pg_dump indisponível?).' : 'Falha ao exportar o banco de dados.' });
    }
    entries.push({ name: dumpName, role: 'postgres-dump', bytes: fs.statSync(dumpPath).size, sha256: sha256File(dumpPath) });

    // 2) Chave mestra — só quando ela vive em arquivo (ver src/backup.js).
    const keySource = encryptionKeySource();
    if (keySource === 'file') {
      const source = keyFilePath();
      const target = path.join(stage, 'encryption.key');
      fs.copyFileSync(source, target);
      try { fs.chmodSync(target, 0o600); } catch {}
      entries.push({ name: 'encryption.key', role: 'encryption-key', bytes: fs.statSync(target).size, sha256: sha256File(target) });
    }

    // 3) Workspaces (arquivos dos usuários) — entram como diretório no tar.
    const hasWorkspaces = fs.existsSync(wsRoot);
    if (hasWorkspaces) entries.push({ name: `${path.basename(wsRoot)}/`, role: 'workspaces' });

    // 4) Manifesto com versão, schema, checksums e a origem da chave.
    const { schemaVersion, appliedMigrations } = await schemaInfo();
    const manifest = buildManifest({
      createdAt: new Date().toISOString(),
      schemaVersion,
      appliedMigrations,
      appVersion: process.env.APP_VERSION || null,
      keySource,
      entries
    });
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // 5) Empacota e transmite. O tar lê do diretório de staging (manifesto +
    //    dump + chave) e, à parte, do diretório de workspaces.
    const args = ['-czf', '-', '-C', stage, '.'];
    if (hasWorkspaces) args.push('-C', path.dirname(wsRoot), path.basename(wsRoot));
    const tar = spawn('tar', args);
    let headersSent = false;
    const sendHeaders = () => {
      if (headersSent) return;
      headersSent = true;
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="frederico-backup-${stamp}.tar.gz"`);
    };
    tar.stderr.on('data', () => {}); // drena o stderr (senão o buffer enche e o tar trava)
    tar.stdout.on('data', (chunk) => { sendHeaders(); if (!res.write(chunk)) tar.stdout.pause(); });
    res.on('drain', () => tar.stdout.resume());
    // O cliente pode abortar o download no meio: encerra o tar e limpa o staging.
    res.on('close', () => { if (!res.writableEnded) { try { tar.kill('SIGKILL'); } catch {} } cleanup(); });
    tar.stdout.on('end', () => { if (headersSent) res.end(); cleanup(); });
    tar.on('error', (err) => {
      console.error('[backup]', err.message);
      cleanup();
      if (!headersSent) res.status(500).json({ error: 'Falha ao gerar o backup (tar indisponível?).' });
      else res.end();
    });
    tar.on('close', (code) => {
      if (!headersSent && code !== 0) { cleanup(); res.status(500).json({ error: 'Falha ao gerar o backup.' }); }
    });

    await recordAdminAction(req, 'backup.download', {
      chave_mestra: keySource,
      migracoes: appliedMigrations,
      workspaces: hasWorkspaces
    });
  } catch (err) {
    console.error('[backup]', err);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao gerar o backup.' });
  }
});

export default router;
