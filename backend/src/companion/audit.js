// Log de auditoria do copiloto (seção 16): registra TODA ação relevante do
// agente — observar/ler/executar/alterar/instalar/git/notificar — com o ator, o
// nível de permissão vigente, se houve autorização explícita e o resultado.
// É o que torna os níveis de autonomia seguros e transparentes.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';

const CATEGORY = ['observar', 'ler', 'executar', 'alterar', 'instalar', 'git', 'notificar'];
const LEVEL = ['info', 'aviso', 'critico'];
const str = (v, max = 2000) => (v == null ? null : String(v).slice(0, max));
const pick = (v, allowed, fb) => (allowed.includes(v) ? v : fb);

function serialize(r) {
  if (!r) return null;
  return {
    id: r.id, project: r.project, actor: r.actor, category: r.category, action: r.action,
    target: r.target, permLevel: r.perm_level, authorized: !!r.authorized, level: r.level,
    detail: r.detail, result: r.result, createdAt: r.created_at,
  };
}

// Registra uma entrada de auditoria. Nunca lança (auditoria não pode derrubar a
// ação que está auditando) — em erro, apenas loga.
export async function audit(userId, entry = {}) {
  try {
    const id = nanoid();
    await db.prepare(
      `INSERT INTO companion_audit (id,user_id,project,actor,category,action,target,perm_level,authorized,level,detail,result,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, userId, str(entry.project, 200), str(entry.actor, 120),
      pick(entry.category, CATEGORY, 'observar'), str(entry.action, 300) || 'ação',
      str(entry.target, 500), Number.isFinite(Number(entry.permLevel)) ? Number(entry.permLevel) : null,
      entry.authorized ? 1 : 0, pick(entry.level, LEVEL, 'info'), str(entry.detail, 2000),
      str(entry.result, 2000), now(),
    );
    return id;
  } catch (e) {
    console.error('[copiloto] auditoria falhou:', e.message);
    return null;
  }
}

export async function listAudit(userId, { project = null, category = null, limit = 200 } = {}) {
  const clauses = ['user_id=?']; const params = [userId];
  if (project) { clauses.push('project=?'); params.push(project); }
  if (category) { clauses.push('category=?'); params.push(category); }
  params.push(Math.min(1000, limit));
  const rows = await db.prepare(`SELECT * FROM companion_audit WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...params);
  return rows.map(serialize);
}
