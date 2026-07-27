// Camada de dados do Modo Design. Toda leitura e escrita é escopada por
// `user_id` — inclusive a das versões, que já têm o projeto como dono. É a
// convenção do app: o isolamento é verificado na linha consultada, nunca só
// por junção (uma junção esquecida vira vazamento entre contas).
//
// A única função que NÃO recebe usuário é `getProjectByToken`: o preview é uma
// capacidade (ver a nota 2 da migration 022 e docs/DESIGN_STUDIO.md).
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { sanitizeAdjustments } from './tokens.js';

// Quantas versões ficam navegáveis por projeto. Um HTML gerado tem dezenas de
// KB e o refinamento por conversa cria uma versão POR MENSAGEM — sem poda, um
// projeto muito conversado cresceria sem teto no banco.
export const MAX_VERSIONS = Math.max(5, Number(process.env.DESIGN_MAX_VERSIONS || 30));
// Teto de mensagens do chat de um projeto devolvidas ao frontend.
const MESSAGE_LIMIT = 200;

// Token do preview: 32 caracteres do alfabeto do nanoid (~190 bits). É a única
// coisa que separa o artefato de quem tiver a URL, então não pode ser curto.
const newPreviewToken = () => nanoid(32);

export function serializeProject(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    outputType: row.output_type,
    designSystemId: row.design_system_id || null,
    previewToken: row.preview_token,
    currentVersionId: row.current_version_id || null,
    adjustments: parseAdjustments(row.adjustments),
    modelRef: row.model_ref || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

export function serializeVersion(row, { withContent = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    promptUsed: row.prompt_used || '',
    createdAt: row.created_at,
    size: String(row.content || '').length,
  };
  if (withContent) base.content = row.content;
  return base;
}

export function serializeDesignSystem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    primaryColor: row.primary_color || null,
    secondaryColor: row.secondary_color || null,
    fontHeading: row.font_heading || null,
    fontBody: row.font_body || null,
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    versionId: row.version_id || null,
    createdAt: row.created_at,
  };
}

// ---- Projetos ---------------------------------------------------------------

export async function createProject(userId, { title, outputType, designSystemId = null, modelRef = null }) {
  const id = nanoid();
  const t = now();
  await db.prepare(
    `INSERT INTO design_projects (id,user_id,title,output_type,design_system_id,preview_token,model_ref,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, userId, title, outputType, designSystemId, newPreviewToken(), modelRef || null, t, t);
  return getProject(userId, id);
}

export async function getProject(userId, id) {
  return db.prepare('SELECT * FROM design_projects WHERE id=? AND user_id=?').get(id, userId);
}

// Resolve o projeto a partir do token do preview. Sem escopo de usuário DE
// PROPÓSITO: quem serve o preview é uma rota sem sessão, para que ela possa
// morar em outra origem (DESIGN_PREVIEW_ORIGIN) sem cookie nenhum.
export async function getProjectByToken(token) {
  const value = String(token || '');
  if (value.length < 16) return null; // corta sondagem barata antes de ir ao banco
  return db.prepare('SELECT * FROM design_projects WHERE preview_token=?').get(value);
}

export async function listProjects(userId) {
  const rows = await db.prepare(
    `SELECT p.*, v.version_number AS current_version_number,
            (SELECT COUNT(*) FROM design_versions dv WHERE dv.project_id = p.id) AS version_count
       FROM design_projects p
       LEFT JOIN design_versions v ON v.id = p.current_version_id
      WHERE p.user_id=?
      ORDER BY p.updated_at DESC`
  ).all(userId);
  return rows.map(row => serializeProject(row, {
    currentVersionNumber: row.current_version_number ?? null,
    versionCount: Number(row.version_count || 0),
  }));
}

export async function updateProject(userId, id, { title, designSystemId, modelRef }) {
  const sets = [], params = [];
  if (title !== undefined) { sets.push('title=?'); params.push(title); }
  if (designSystemId !== undefined) { sets.push('design_system_id=?'); params.push(designSystemId || null); }
  // Modelo vazio LIMPA a fixação: o projeto volta a seguir o modelo do app.
  if (modelRef !== undefined) { sets.push('model_ref=?'); params.push(modelRef || null); }
  if (!sets.length) return getProject(userId, id);
  sets.push('updated_at=?'); params.push(now(), id, userId);
  await db.prepare(`UPDATE design_projects SET ${sets.join(',')} WHERE id=? AND user_id=?`).run(...params);
  return getProject(userId, id);
}

export async function deleteProject(userId, id) {
  const r = await db.prepare('DELETE FROM design_projects WHERE id=? AND user_id=?').run(id, userId);
  return r.changes > 0;
}

// Gera um token novo e invalida o antigo — a saída para "compartilhei a URL do
// preview sem querer".
export async function rotatePreviewToken(userId, id) {
  const token = newPreviewToken();
  const r = await db.prepare('UPDATE design_projects SET preview_token=?, updated_at=? WHERE id=? AND user_id=?')
    .run(token, now(), id, userId);
  return r.changes > 0 ? token : null;
}

// Ajustes gravados. Passam por `sanitizeAdjustments` mesmo vindo do BANCO: a
// coluna é texto livre para o Postgres, e um valor gravado por uma versão
// antiga do código (ou por um restore) não pode virar CSS sem conferência.
function parseAdjustments(raw) {
  if (!raw) return {};
  try { return sanitizeAdjustments(JSON.parse(raw)); } catch { return {}; }
}

export async function setAdjustments(userId, projectId, adjustments) {
  const clean = sanitizeAdjustments(adjustments);
  const value = Object.keys(clean).length ? JSON.stringify(clean) : null;
  const r = await db.prepare('UPDATE design_projects SET adjustments=?, updated_at=? WHERE id=? AND user_id=?')
    .run(value, now(), projectId, userId);
  return r.changes > 0 ? clean : null;
}

// Ajustes a partir do id do projeto — usado pela rota de prévia, que não tem
// sessão e por isso não pode passar por `getProject`.
export async function adjustmentsByProjectId(projectId) {
  const row = await db.prepare('SELECT adjustments FROM design_projects WHERE id=?').get(projectId);
  return parseAdjustments(row?.adjustments);
}

// ---- Versões ----------------------------------------------------------------

export async function currentVersion(userId, projectId) {
  return db.prepare(
    `SELECT v.* FROM design_versions v
       JOIN design_projects p ON p.current_version_id = v.id
      WHERE p.id=? AND p.user_id=? AND v.user_id=?`
  ).get(projectId, userId, userId);
}

// Versão atual a partir do token (rota de preview, sem sessão).
export async function currentVersionByProjectId(projectId) {
  return db.prepare(
    `SELECT v.* FROM design_versions v
       JOIN design_projects p ON p.current_version_id = v.id
      WHERE p.id=?`
  ).get(projectId);
}

export async function getVersion(userId, projectId, versionId) {
  return db.prepare('SELECT * FROM design_versions WHERE id=? AND project_id=? AND user_id=?')
    .get(versionId, projectId, userId);
}

export async function listVersions(userId, projectId) {
  const rows = await db.prepare(
    'SELECT * FROM design_versions WHERE project_id=? AND user_id=? ORDER BY version_number DESC'
  ).all(projectId, userId);
  return rows.map(row => serializeVersion(row));
}

// Cria a próxima versão e a torna a atual, numa transação: sem isso, duas
// gerações simultâneas no mesmo projeto poderiam calcular o mesmo
// `version_number` (a UNIQUE do schema barraria a segunda, mas com um erro de
// banco no lugar de uma mensagem entendível) ou deixar o ponteiro para trás.
export const addVersion = db.transaction(async (userId, projectId, { content, promptUsed = '' }) => {
  const last = await db.prepare(
    'SELECT COALESCE(MAX(version_number),0) AS n FROM design_versions WHERE project_id=?'
  ).get(projectId);
  const versionNumber = Number(last?.n || 0) + 1;
  const id = nanoid();
  const t = now();
  await db.prepare(
    'INSERT INTO design_versions (id,project_id,user_id,version_number,content,prompt_used,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, projectId, userId, versionNumber, content, promptUsed || null, t);
  await db.prepare('UPDATE design_projects SET current_version_id=?, updated_at=? WHERE id=? AND user_id=?')
    .run(id, t, projectId, userId);
  await pruneVersions(projectId);
  return db.prepare('SELECT * FROM design_versions WHERE id=?').get(id);
});

// Poda as versões mais antigas além do teto.
//
// A cláusula que protege `current_version_id` não é decoração: a versão em
// exibição pode ser ANTIGA (é o que "reverter" faz — o ponteiro volta sem
// apagar o que veio depois), e apagá-la deixaria o projeto sem nada para
// renderizar. No fluxo de hoje `addVersion` já move o ponteiro para a versão
// recém-criada antes de podar, então a cláusula raramente decide algo; ela
// existe para que a poda continue segura se for chamada de outro lugar — uma
// varredura de retenção, por exemplo. Exportada para poder ser testada nesse
// cenário, que é justamente o que a torna necessária.
export async function pruneVersions(projectId) {
  await db.prepare(
    `DELETE FROM design_versions
      WHERE project_id=?
        AND id <> COALESCE((SELECT current_version_id FROM design_projects WHERE id=?), '')
        AND version_number <= (
          SELECT COALESCE(MAX(version_number),0) - ? FROM design_versions WHERE project_id=?
        )`
  ).run(projectId, projectId, MAX_VERSIONS, projectId);
}

// Reverter é mover o ponteiro, não apagar o que veio depois: o usuário pode
// voltar para a versão 5 e, de lá, seguir refinando — a 6 e a 7 continuam no
// histórico até a poda alcançá-las.
export async function setCurrentVersion(userId, projectId, versionId) {
  const version = await getVersion(userId, projectId, versionId);
  if (!version) return null;
  await db.prepare('UPDATE design_projects SET current_version_id=?, updated_at=? WHERE id=? AND user_id=?')
    .run(versionId, now(), projectId, userId);
  return version;
}

// ---- Chat do projeto --------------------------------------------------------

export async function listMessages(userId, projectId, limit = MESSAGE_LIMIT) {
  const rows = await db.prepare(
    'SELECT * FROM design_messages WHERE project_id=? AND user_id=? ORDER BY created_at ASC LIMIT ?'
  ).all(projectId, userId, limit);
  return rows.map(serializeMessage);
}

export async function addMessage(userId, projectId, role, content, versionId = null) {
  const id = nanoid();
  const t = now();
  await db.prepare(
    'INSERT INTO design_messages (id,project_id,user_id,role,content,version_id,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, projectId, userId, role, String(content || ''), versionId, t);
  return { id, role, content: String(content || ''), versionId, createdAt: t };
}

// ---- Design systems ---------------------------------------------------------

export async function listDesignSystems(userId) {
  const rows = await db.prepare('SELECT * FROM design_systems WHERE user_id=? ORDER BY created_at ASC').all(userId);
  return rows.map(serializeDesignSystem);
}

export async function getDesignSystem(userId, id) {
  if (!id) return null;
  const row = await db.prepare('SELECT * FROM design_systems WHERE id=? AND user_id=?').get(id, userId);
  return serializeDesignSystem(row);
}

export async function createDesignSystem(userId, input) {
  const id = nanoid();
  const t = now();
  await db.prepare(
    `INSERT INTO design_systems (id,user_id,name,primary_color,secondary_color,font_heading,font_body,notes,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, userId, input.name, input.primaryColor, input.secondaryColor, input.fontHeading, input.fontBody, input.notes, t, t);
  return getDesignSystem(userId, id);
}

export async function updateDesignSystem(userId, id, input) {
  const r = await db.prepare(
    `UPDATE design_systems SET name=?, primary_color=?, secondary_color=?, font_heading=?, font_body=?, notes=?, updated_at=?
      WHERE id=? AND user_id=?`
  ).run(input.name, input.primaryColor, input.secondaryColor, input.fontHeading, input.fontBody, input.notes, now(), id, userId);
  return r.changes > 0 ? getDesignSystem(userId, id) : null;
}

export async function deleteDesignSystem(userId, id) {
  const r = await db.prepare('DELETE FROM design_systems WHERE id=? AND user_id=?').run(id, userId);
  return r.changes > 0;
}
