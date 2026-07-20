// Rotas de backup — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { makeRouter, isAdmin } from './helpers.js';

const router = makeRouter();

// Backup completo (banco + workspaces) num .tar.gz para download.
// O banco agora é PostgreSQL: geramos um dump com pg_dump e o empacotamos junto
// com os workspaces. (Requer o cliente `pg_dump` no ambiente — incluído na
// imagem do backend.)
router.get('/backup', (req, res) => {
  // Backup = banco INTEIRO + todos os workspaces (dados de TODOS os usuários).
  // Só o administrador pode baixar.
  if (!isAdmin(req)) return res.status(403).json({ error: 'Apenas o administrador pode baixar o backup completo.' });
  const stamp = new Date().toISOString().slice(0, 10);
  const wsRoot = path.resolve(process.env.WORKSPACE_ROOT || './workspaces');
  const dumpName = `frederico-db-${stamp}.sql`;
  const dumpPath = path.join('/tmp', dumpName);
  const dbUrl = process.env.DATABASE_URL || 'postgres://studio:studio@postgres:5432/studio';

  // 1) Dump do PostgreSQL para um arquivo temporário.
  const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', '-f', dumpPath, dbUrl]);
  dump.stderr.on('data', () => {});
  dump.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Backup do banco falhou (pg_dump indisponível?).' }); });
  dump.on('close', (dumpCode) => {
    if (dumpCode !== 0) { if (!res.headersSent) res.status(500).json({ error: 'Falha ao exportar o banco de dados.' }); return; }

    // 2) Empacota o dump do banco + os workspaces num .tar.gz e transmite.
    const args = ['-czf', '-', '-C', '/tmp', dumpName];
    if (fs.existsSync(wsRoot)) args.push('-C', path.dirname(wsRoot), path.basename(wsRoot));
    const tar = spawn('tar', args);
    let headersSent = false;
    const cleanup = () => { try { fs.rmSync(dumpPath, { force: true }); } catch {} };
    const sendHeaders = () => {
      if (headersSent) return;
      headersSent = true;
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="frederico-backup-${stamp}.tar.gz"`);
    };
    tar.stderr.on('data', () => {}); // drena o stderr (senão o buffer enche e o tar trava)
    tar.stdout.on('data', (chunk) => { sendHeaders(); if (!res.write(chunk)) tar.stdout.pause(); });
    res.on('drain', () => tar.stdout.resume());
    tar.stdout.on('end', () => { if (headersSent) res.end(); cleanup(); });
    // Falha antes de qualquer byte (ex.: tar ausente): responde erro JSON em vez
    // de um .tar.gz truncado que o usuário baixaria sem perceber.
    tar.on('error', (err) => { console.error('[backup]', err); cleanup(); if (!headersSent) res.status(500).json({ error: 'Falha ao gerar o backup (tar indisponível?).' }); else res.end(); });
    tar.on('close', (code) => { if (!headersSent && code !== 0) { cleanup(); res.status(500).json({ error: 'Falha ao gerar o backup.' }); } });
  });
});

export default router;
