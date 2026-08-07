// Projetos do Modo Desenvolvedor — CRUD no servidor (ADR 0004).
//
// A fonte de verdade dos projetos (vínculo repo/pasta, regras, memória
// permanente, permissões concedidas, modo) passa a ser o banco; o navegador
// vira cache. Regras:
//  - toda rota exige sessão (makeRouter) e prova a POSSE (user_id);
//  - `permissions` é REGISTRO da decisão do usuário — quem concede de fato é a
//    re-validação no uso (githubAccess.js / permissionPolicy.js), então aqui
//    só cabem limites de tamanho/forma;
//  - a lista de conversas de cada projeto DERIVA de conversations.project_id;
//    o cliente pode enviar conversationIds (histórico do localStorage) e eles
//    são ADOTADOS (só conversas do próprio usuário, ainda sem projeto);
//  - /import é a migração única do localStorage: upsert em lote, idempotente.
import { makeRouter } from './helpers.js';
import { adoptConversations, deleteProject, getProject, listProjects, upsertProject } from '../memory/projectStore.js';

const router = makeRouter();

const MAX_IMPORT = 100;
const MAX_TEXT = 20_000;

// Normalização defensiva de ENTRADA (tamanhos/da forma). A normalização de
// conteúdo (memória com as chaves certas, modo válido, permissions no uso) é
// do projectStore e dos módulos de autorização.
function sanitizeProjectInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim().slice(0, 200);
  if (!id || id.length > 60 || !/^[A-Za-z0-9_.:-]+$/.test(id) || !name) return null;
  const clip = (value) => String(value || '').slice(0, MAX_TEXT);
  const binding = raw.binding && typeof raw.binding === 'object' && !Array.isArray(raw.binding) ? raw.binding : { type: 'none' };
  const project = {
    id,
    name,
    description: clip(raw.description),
    techs: clip(raw.techs),
    rules: clip(raw.rules),
    memory: raw.memory && typeof raw.memory === 'object' ? raw.memory : {},
    binding,
    mode: raw.mode
  };
  // `permissions` só viaja quando veio no payload (COALESCE no upsert preserva
  // o registro do servidor para chamadores que não enviam o campo).
  if (raw.permissions !== undefined) {
    project.permissions = raw.permissions && typeof raw.permissions === 'object' && !Array.isArray(raw.permissions)
      ? JSON.parse(JSON.stringify(raw.permissions).slice(0, MAX_TEXT))
      : null;
  }
  const conversationIds = Array.isArray(raw.conversationIds)
    ? raw.conversationIds.filter(value => typeof value === 'string').slice(0, 200)
    : [];
  return { project, conversationIds };
}

router.get('/dev-projects', async (req, res) => {
  res.json({ projects: await listProjects(req.userId) });
});

// Cria OU atualiza um projeto (o id vem do cliente — mesmo formato usado desde
// o localStorage, o que mantém a migração idempotente).
router.put('/dev-projects/:id', async (req, res) => {
  const input = sanitizeProjectInput({ ...req.body, id: req.params.id });
  if (!input) return res.status(400).json({ error: 'Projeto inválido: id e nome são obrigatórios.' });
  const saved = await upsertProject(req.userId, input.project);
  if (!saved) return res.status(400).json({ error: 'Não foi possível salvar o projeto.' });
  if (input.conversationIds.length) await adoptConversations(req.userId, saved.id, input.conversationIds);
  res.json({ project: await getProject(req.userId, saved.id) });
});

router.delete('/dev-projects/:id', async (req, res) => {
  const ok = await deleteProject(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ ok: true });
});

// Migração única do localStorage: o navegador envia tudo o que tem; o servidor
// faz upsert em lote e adota as conversas. Idempotente — repetir não duplica.
router.post('/dev-projects/import', async (req, res) => {
  const raw = Array.isArray(req.body?.projects) ? req.body.projects.slice(0, MAX_IMPORT) : [];
  let imported = 0;
  for (const item of raw) {
    const input = sanitizeProjectInput(item);
    if (!input) continue;
    const saved = await upsertProject(req.userId, input.project);
    if (!saved) continue;
    imported += 1;
    if (input.conversationIds.length) await adoptConversations(req.userId, saved.id, input.conversationIds);
  }
  res.json({ imported, projects: await listProjects(req.userId) });
});

export default router;
