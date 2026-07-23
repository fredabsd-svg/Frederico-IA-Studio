// Camada de dados dos eventos do Companion (compartilhada entre a rota HTTP e o
// monitoramento). Concentra a criação/serialização e a deduplicação para que
// nenhum call site precise repetir o SQL nem a regra de "não repetir alerta".
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';

const EVENT_LEVELS = ['info', 'aviso', 'critico'];
const str = (v, max = 4000) => (v == null ? null : String(v).slice(0, max));
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

export function serializeEvent(e) {
  return {
    id: e.id, kind: e.kind, level: e.level, title: e.title, detail: e.detail,
    origin: e.origin, project: e.project, dataSent: e.data_sent,
    proposedAction: e.proposed_action, authorization: e.authz,
    result: e.result, status: e.status, createdAt: e.created_at, updatedAt: e.updated_at,
  };
}

// Cria um evento e devolve a forma serializada. `evt` usa camelCase (a mesma do
// front); aqui traduzimos para as colunas.
export async function createEvent(userId, evt = {}) {
  const id = nanoid();
  const t = now();
  await db.prepare(
    `INSERT INTO companion_events
     (id,user_id,kind,level,title,detail,origin,project,data_sent,proposed_action,authz,result,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, userId, str(evt.kind, 60) || 'geral', pick(evt.level, EVENT_LEVELS, 'info'),
    str(evt.title, 200), str(evt.detail, 4000), str(evt.origin, 60) || 'app', str(evt.project, 200),
    str(evt.dataSent, 4000), str(evt.proposedAction, 2000), str(evt.authorization, 60), str(evt.result, 4000),
    'novo', t, t,
  );
  return serializeEvent(await db.prepare('SELECT * FROM companion_events WHERE id=? AND user_id=?').get(id, userId));
}

// Existe um alerta AINDA PENDENTE do mesmo tipo (e, opcionalmente, do mesmo
// projeto)? Usado para não recriar o mesmo aviso a cada ciclo de monitoramento.
export async function hasOpenEvent(userId, kind, project = null) {
  const row = project
    ? await db.prepare(`SELECT 1 FROM companion_events WHERE user_id=? AND kind=? AND project=? AND status IN ('novo','visto') LIMIT 1`).get(userId, kind, project)
    : await db.prepare(`SELECT 1 FROM companion_events WHERE user_id=? AND kind=? AND status IN ('novo','visto') LIMIT 1`).get(userId, kind);
  return !!row;
}

// Cria o evento apenas se ainda não houver um pendente do mesmo tipo/projeto.
// Devolve o evento criado, ou null se foi suprimido pela deduplicação.
export async function createEventOnce(userId, evt) {
  if (await hasOpenEvent(userId, evt.kind, evt.project ?? null)) return null;
  return createEvent(userId, evt);
}
