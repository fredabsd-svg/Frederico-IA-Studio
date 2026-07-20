// Rotas de pcFolders — movidas do server.js na modularização (mesma lógica,
// mesmo comportamento). Montado em /api pelo server.js.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { destroyAllSandboxes } from '../sandbox.js';
import { makeRouter, PC_FOLDERS_ENABLED } from './helpers.js';

const router = makeRouter();

// ---- Pastas do Computador (acesso do assistente a pastas reais do PC) ----
// Rejeita raízes de disco e pastas de sistema (Windows e Linux) — inclusive
// qualquer subpasta delas — para o assistente nunca montar o SO inteiro nem
// diretórios sensíveis (ex.: /var/run com o docker.sock).
function isDangerousHostPath(raw) {
  const p = String(raw || '').trim();
  if (!p) return true;
  // Rejeita qualquer travessia de diretório ("..") — sem isso a blocklist
  // abaixo é burlável (ex.: /home/x/../../etc). Não há caso legítimo com "..".
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p)) return true;
  const stripped = p.replace(/[\\/]+$/, '');
  if (stripped === '' || stripped === '.') return true;              // raiz POSIX "/" ou "\"
  if (/^[a-z]:$/i.test(stripped)) return true;                        // "C:"
  if (/^\\\\[^\\]+\\?[^\\]*$/.test(stripped)) return true;            // UNC "\\servidor\share"
  const norm = stripped.replace(/\\/g, '/').toLowerCase();
  const winSys = /^[a-z]:\/(windows|program files( \(x86\))?|programdata|\$recycle\.bin)(\/|$)/;
  if (winSys.test(norm)) return true;
  const posixSys = /^\/(etc|root|proc|sys|dev|boot|bin|sbin|lib|lib64|usr|var|run)(\/|$)/;
  if (posixSys.test(norm)) return true;
  return false;
}
// Numa VPS pública o recurso fica DESLIGADO (montar caminhos do host é
// perigoso). Habilite só em uso pessoal com ENABLE_PC_FOLDERS=true.
function requirePcFolders(res) {
  if (PC_FOLDERS_ENABLED) return true;
  res.status(403).json({ error: 'O recurso "Pastas do PC" está desativado nesta instalação (uso pessoal apenas).' });
  return false;
}
router.get('/pc-folders', async (req, res) => {
  if (!PC_FOLDERS_ENABLED) return res.json([]);
  res.json(await db.prepare('SELECT id, label, host_path, writable FROM pc_folders WHERE user_id=? ORDER BY created_at ASC').all(req.userId));
});
router.post('/pc-folders', async (req, res) => {
  if (!requirePcFolders(res)) return;
  const label = (req.body?.label || '').trim();
  const hostPath = (req.body?.host_path || '').trim();
  if (!label || !hostPath) return res.status(400).json({ error: 'Nome e caminho da pasta são obrigatórios.' });
  if (isDangerousHostPath(hostPath)) return res.status(400).json({ error: 'Por segurança, não é permitido liberar a raiz do disco nem pastas do sistema (Windows, Arquivos de Programas, /etc, /var etc.). Escolha uma pasta específica de trabalho.' });
  const id = nanoid();
  await db.prepare('INSERT INTO pc_folders (id,user_id,label,host_path,writable,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, req.userId, label, hostPath, req.body?.writable ? 1 : 0, now());
  await destroyAllSandboxes(); // aplica o novo mount às conversas em andamento
  res.json({ id, label, host_path: hostPath, writable: req.body?.writable ? 1 : 0 });
});
router.put('/pc-folders/:id', async (req, res) => {
  if (!requirePcFolders(res)) return;
  await db.prepare('UPDATE pc_folders SET writable=? WHERE id=? AND user_id=?').run(req.body?.writable ? 1 : 0, req.params.id, req.userId);
  await destroyAllSandboxes();
  res.json({ ok: true });
});
router.delete('/pc-folders/:id', async (req, res) => {
  if (!requirePcFolders(res)) return;
  await db.prepare('DELETE FROM pc_folders WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  await destroyAllSandboxes();
  res.json({ ok: true });
});

export default router;
