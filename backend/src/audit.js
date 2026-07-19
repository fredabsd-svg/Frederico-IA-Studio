// Trilha de auditoria (especificação de produção, seções 5 e 8): registra
// chamadas a recursos externos e downloads com usuário, conversa e um resumo
// do parâmetro. Fire-and-forget: auditoria NUNCA derruba nem atrasa a
// operação auditada — falha de banco aqui vira só um log de erro.
import { nanoid } from 'nanoid';
import { db, now } from './db.js';

const DETAIL_MAX = 500;

export function logAudit({ userId = null, conversationId = null, kind, detail = '' }) {
  try {
    const p = db.prepare(
      'INSERT INTO audit_log (id,user_id,conversation_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)'
    ).run(
      nanoid(),
      userId ? String(userId) : null,
      conversationId ? String(conversationId) : null,
      String(kind || 'evento'),
      String(detail || '').slice(0, DETAIL_MAX),
      now()
    );
    if (p?.catch) p.catch((e) => console.error('[audit]', e.message));
  } catch (e) {
    console.error('[audit]', e?.message || e);
  }
}
