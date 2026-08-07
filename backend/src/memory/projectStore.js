import { db, now } from '../db.js';

// Projetos do Modo Desenvolvedor no servidor.
//
// O navegador continua sendo onde o usuário edita o projeto (useDevProjects),
// mas a recuperação de contexto roda no backend — então ele precisa saber:
//   * que projeto está ativo;
//   * que conversas pertencem a esse projeto;
//   * o que já foi decidido/corrigido nele.
//
// Sem isto, abrir um chat novo dentro de um projeto era indistinguível de abrir
// um chat do zero: a busca caía na similaridade global e trazia memórias
// antigas e genéricas em vez da continuidade do trabalho.

const MEMORY_KEYS = ['arquitetura', 'decisoes', 'padroes', 'corrigidos', 'preferencias', 'proximos'];

export const MEMORY_LABEL = {
  arquitetura: 'Arquitetura do sistema',
  decisoes: 'Decisões técnicas',
  padroes: 'Padrões de código',
  corrigidos: 'Problemas já corrigidos',
  preferencias: 'Preferências do usuário',
  proximos: 'Próximas etapas planejadas'
};

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeMemory(memory) {
  const src = parseJson(memory, {}) || {};
  const out = {};
  for (const key of MEMORY_KEYS) out[key] = String(src[key] || '').trim();
  return out;
}

// Modos válidos do Modo Desenvolvedor (espelho de prompts.js DEV_MODES; a
// validação real do modo acontece lá — aqui só evitamos lixo na coluna).
const VALID_MODES = new Set(['ask', 'plan', 'build', 'fix', 'review', 'auto']);
const normalizeMode = (value) => (VALID_MODES.has(String(value || '')) ? String(value) : null);

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    memory: normalizeMemory(row.memory),
    binding: parseJson(row.binding, { type: 'none' }),
    // Permissões são REGISTRO da decisão do usuário; quem concede de fato é a
    // re-validação no uso (githubAccess.js / permissionPolicy.js).
    permissions: parseJson(row.permissions, null),
    mode: normalizeMode(row.mode)
  };
}

// Espelha o projeto do navegador. É idempotente: o mesmo id sempre atualiza a
// mesma linha, então sincronizar a cada abertura de chat não duplica nada.
export async function upsertProject(userId, project) {
  const id = String(project?.id || '').trim();
  const name = String(project?.name || '').trim();
  if (!id || !name) return null;
  const t = now();
  await db.prepare(`
    INSERT INTO dev_projects (id, user_id, name, description, techs, rules, memory, binding, permissions, mode, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (id) DO UPDATE SET
      name=excluded.name, description=excluded.description, techs=excluded.techs,
      rules=excluded.rules, memory=excluded.memory, binding=excluded.binding,
      permissions=COALESCE(excluded.permissions, dev_projects.permissions),
      mode=COALESCE(excluded.mode, dev_projects.mode),
      updated_at=excluded.updated_at
    WHERE dev_projects.user_id = excluded.user_id
  `).run(
    id, userId, name,
    String(project.description || ''), String(project.techs || ''), String(project.rules || ''),
    JSON.stringify(normalizeMemory(project.memory)),
    JSON.stringify(project.binding || { type: 'none' }),
    // COALESCE acima: um chamador antigo (sem os campos) não apaga o que o
    // servidor já guardou — só quem envia o campo o substitui.
    project.permissions !== undefined ? JSON.stringify(project.permissions) : null,
    normalizeMode(project.mode),
    t, t
  );
  return getProject(userId, id);
}

// Lista os projetos do usuário com as conversas de cada um DERIVADAS de
// conversations.project_id (a fonte que o backend mantém) — mais recentes
// primeiro, teto de 50 por projeto, como o navegador fazia.
export async function listProjects(userId) {
  if (!userId) return [];
  const rows = await db.prepare('SELECT * FROM dev_projects WHERE user_id=? ORDER BY created_at ASC').all(userId);
  const projects = rows.map(hydrate);
  if (!projects.length) return [];
  const convRows = await db.prepare(`
    SELECT id, project_id FROM conversations
    WHERE user_id=? AND project_id IS NOT NULL
    ORDER BY updated_at DESC
  `).all(userId);
  const byProject = new Map();
  for (const row of convRows) {
    const list = byProject.get(row.project_id) || [];
    if (list.length < 50) list.push(row.id);
    byProject.set(row.project_id, list);
  }
  return projects.map(project => ({ ...project, conversationIds: byProject.get(project.id) || [] }));
}

// Remove o projeto e SOLTA as conversas (project_id=NULL) — apagar um projeto
// não pode apagar histórico de conversa.
export async function deleteProject(userId, projectId) {
  if (!userId || !projectId) return false;
  const owned = await db.prepare('SELECT 1 FROM dev_projects WHERE id=? AND user_id=?').get(projectId, userId);
  if (!owned) return false;
  await db.prepare('UPDATE conversations SET project_id=NULL WHERE user_id=? AND project_id=?').run(userId, projectId);
  await db.prepare('UPDATE conversation_chunks SET project_id=NULL WHERE user_id=? AND project_id=?').run(userId, projectId);
  await db.prepare('DELETE FROM dev_projects WHERE id=? AND user_id=?').run(projectId, userId);
  return true;
}

export async function getProject(userId, projectId) {
  if (!projectId) return null;
  return hydrate(await db.prepare('SELECT * FROM dev_projects WHERE id=? AND user_id=?').get(projectId, userId));
}

// Carimba a conversa com o projeto. Os chunks já gravados desta conversa também
// recebem o vínculo — senão o histórico anterior ao vínculo ficaria invisível
// para a recuperação por projeto.
export async function linkConversationToProject(userId, conversationId, projectId) {
  if (!conversationId || !projectId) return false;
  const owned = await db.prepare('SELECT 1 FROM dev_projects WHERE id=? AND user_id=?').get(projectId, userId);
  if (!owned) return false;
  await db.prepare('UPDATE conversations SET project_id=? WHERE id=? AND user_id=?').run(projectId, conversationId, userId);
  await db.prepare('UPDATE conversation_chunks SET project_id=? WHERE conversation_id=? AND user_id=? AND project_id IS DISTINCT FROM ?')
    .run(projectId, conversationId, userId, projectId);
  return true;
}

// Adota de uma vez as conversas que o navegador já sabia pertencerem ao projeto
// (o histórico que vivia só no localStorage). Sem isto, um projeto antigo só
// voltaria a ter continuidade depois que o usuário reabrisse cada conversa uma
// a uma — o benefício demoraria a aparecer justamente para quem já tem
// histórico acumulado.
export async function adoptConversations(userId, projectId, conversationIds = []) {
  const ids = [...new Set((conversationIds || []).filter(Boolean).map(String))].slice(0, 200);
  if (!projectId || !ids.length) return 0;
  const owned = await db.prepare('SELECT 1 FROM dev_projects WHERE id=? AND user_id=?').get(projectId, userId);
  if (!owned) return 0;
  const ph = ids.map(() => '?').join(',');
  // Só adota conversas ainda sem dono: se o usuário já moveu uma conversa para
  // outro projeto, o vínculo atual manda.
  const res = await db.prepare(`UPDATE conversations SET project_id=? WHERE user_id=? AND project_id IS NULL AND id IN (${ph})`)
    .run(projectId, userId, ...ids);
  await db.prepare(`UPDATE conversation_chunks SET project_id=? WHERE user_id=? AND project_id IS NULL AND conversation_id IN (${ph})`)
    .run(projectId, userId, ...ids);
  return res?.changes || 0;
}

export async function projectIdForConversation(userId, conversationId) {
  if (!conversationId) return null;
  const row = await db.prepare('SELECT project_id FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId);
  return row?.project_id || null;
}

// As últimas conversas do projeto, mais recentes primeiro. É a camada 1 da
// recuperação: continuidade não é questão de similaridade, é de "onde paramos".
export async function recentProjectConversations(userId, projectId, { limit = 6, excludeConversationId = null } = {}) {
  if (!projectId) return [];
  const excl = excludeConversationId ? ' AND id <> ?' : '';
  const params = [userId, projectId];
  if (excludeConversationId) params.push(excludeConversationId);
  return db.prepare(`
    SELECT id, title, summary_short, summary_long, updated_at, created_at
    FROM conversations
    WHERE user_id=? AND project_id=?${excl}
      AND (summary_short IS NOT NULL OR summary_long IS NOT NULL)
    ORDER BY updated_at DESC
    LIMIT ${Math.max(1, Math.min(20, Number(limit) || 6))}
  `).all(...params);
}

// Trechos das conversas do projeto, mais recentes primeiro. Diferente da busca
// semântica: aqui o critério é pertencer ao projeto, não parecer com o texto.
export async function recentProjectChunks(userId, projectId, { limit = 8, excludeConversationId = null } = {}) {
  if (!projectId) return [];
  const excl = excludeConversationId ? ' AND (conversation_id IS NULL OR conversation_id <> ?)' : '';
  const params = [userId, projectId];
  if (excludeConversationId) params.push(excludeConversationId);
  return db.prepare(`
    SELECT id, conversation_id, source_title, scope, content, created_at
    FROM conversation_chunks
    WHERE user_id=? AND project_id=?${excl}
    ORDER BY created_at DESC
    LIMIT ${Math.max(1, Math.min(40, Number(limit) || 8))}
  `).all(...params);
}

// A memória permanente do projeto vira texto para o contexto. Só entram os
// campos preenchidos — campo vazio não vira linha em branco no prompt.
export function projectMemoryText(project) {
  if (!project) return '';
  const mem = project.memory || {};
  const lines = MEMORY_KEYS.filter(k => (mem[k] || '').trim()).map(k => `- ${MEMORY_LABEL[k]}: ${mem[k].trim()}`);
  if (!lines.length) return '';
  return lines.join('\n');
}

export function projectHeaderText(project) {
  if (!project) return '';
  const parts = [`PROJETO ATIVO: ${project.name}`];
  if (project.description) parts.push(`Descrição: ${project.description}`);
  if (project.techs) parts.push(`Tecnologias: ${project.techs}`);
  return parts.join('\n');
}
