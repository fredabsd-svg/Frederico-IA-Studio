// Rotas do Modo Design: projetos visuais gerados por prompt, refinados por
// conversa, versionados e exportáveis. Montado em /api pelo server.js.
//
// Duas coisas nesta camada merecem atenção antes de mexer:
//
// 1) TUDO que sai daqui como HTML executável passa por `previewResponse`, que
//    carimba a resposta com `Content-Security-Policy: sandbox`. É esse cabeçalho
//    — e não o atributo do <iframe> — que garante ORIGEM OPACA para o código
//    gerado pela IA, inclusive quando alguém abre a URL do preview direto no
//    navegador, fora do app. Ver docs/DESIGN_STUDIO.md §Segurança.
//
// 2) A rota `/design/preview/:token` é a ÚNICA sem sessão de todo este router
//    (a exceção está registrada no server.js). Ela existe justamente para poder
//    ser servida de outra origem — DESIGN_PREVIEW_ORIGIN — sem que o navegador
//    tenha motivo para mandar o cookie do app junto com o artefato não confiável.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { validate, schemas } from '../validation.js';
import { makeRouter, enforceDailyLimit } from './helpers.js';
import {
  sanitizeProjectInput, sanitizeDesignSystemInput, contentMatchesType,
  parseSlidesJson, versionSummary, resolveExportFormat, safeFileName, defaultTitle,
} from '../design/core.js';
import { renderSlidesDeck, renderPlaceholder } from '../design/render.js';
import { generateArtifact } from '../design/generate.js';
import { htmlToPdf } from '../design/pdf.js';
import { slidesToPptx } from '../design/pptx.js';
import {
  createProject, getProject, getProjectByToken, listProjects, updateProject, deleteProject,
  rotatePreviewToken, currentVersion, currentVersionByProjectId, getVersion, listVersions,
  addVersion, setCurrentVersion, listMessages, addMessage,
  listDesignSystems, getDesignSystem, createDesignSystem, updateDesignSystem, deleteDesignSystem,
  serializeProject, serializeVersion,
} from '../design/store.js';

const router = makeRouter();

// Origem alternativa para servir os previews. Vazia por padrão: numa instalação
// de origem única o isolamento vem do CSP `sandbox` (o artefato roda em origem
// opaca de qualquer jeito). Quem puder apontar um segundo domínio para o mesmo
// backend ganha a camada extra de o cookie de sessão nunca acompanhar a
// requisição do artefato — ver docs/DESIGN_STUDIO.md.
const PREVIEW_ORIGIN = String(process.env.DESIGN_PREVIEW_ORIGIN || '').replace(/\/+$/, '');
// Quem pode embutir o preview num <iframe>. Com origem separada, `'self'`
// apontaria para o domínio do preview e o app não conseguiria embutir nada.
const APP_ORIGIN = String(process.env.FRONTEND_URL || process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
const FRAME_ANCESTORS = APP_ORIGIN ? `'self' ${APP_ORIGIN}` : "'self'";

function previewUrl(project) {
  return `${PREVIEW_ORIGIN}/api/design/preview/${project.preview_token}`;
}

const NOT_FOUND = { error: 'Projeto de design não encontrado.' };

// Carrega o projeto do usuário logado ou responde 404. Devolve null quando já
// respondeu — o chamador só precisa checar `if (!project) return`.
async function requireProject(req, res) {
  const project = await getProject(req.userId, req.params.id);
  if (!project) { res.status(404).json(NOT_FOUND); return null; }
  return project;
}

// Serialização completa de um projeto para o frontend (inclui a versão atual).
//
// Recebe o ID e RELÊ a linha de propósito. Gerar ou reverter muda o
// `current_version_id`, e serializar a linha que o handler carregou no começo
// devolveria um ponteiro velho — o preview continuaria mostrando a versão
// anterior e o histórico marcaria a versão errada como "em exibição". Foi
// exatamente esse o defeito que o teste de navegador encontrou.
async function projectPayload(userId, projectId) {
  const project = await getProject(userId, projectId);
  if (!project) return null;
  const version = await currentVersion(userId, project.id);
  return serializeProject(project, {
    previewUrl: previewUrl(project),
    currentVersion: version ? serializeVersion(version, { withContent: true }) : null,
  });
}

// ---- Projetos ---------------------------------------------------------------

router.get('/design/projects', async (req, res) => {
  const projects = await listProjects(req.userId);
  res.json(projects);
});

// Cria o projeto e, quando vem um `prompt`, já gera a primeira versão na mesma
// requisição — é o fluxo da tela inicial ("descreva e veja"). Sem prompt, o
// projeto nasce vazio e a geração acontece pelo chat.
router.post('/design/projects', validate(schemas.designProjectCreate), async (req, res) => {
  const input = sanitizeProjectInput(req.body);
  const prompt = String(req.body?.prompt || '').trim();
  // Sem título explícito, o próprio pedido vira o nome do projeto — mais útil
  // numa lista do que "Novo site", "Novo site", "Novo site".
  if (!req.body?.title && prompt) input.title = prompt.slice(0, 80);
  if (!input.title) input.title = defaultTitle(input.outputType);

  if (input.designSystemId && !await getDesignSystem(req.userId, input.designSystemId)) {
    return res.status(400).json({ error: 'Design system não encontrado.' });
  }

  const project = await createProject(req.userId, input);
  if (!prompt) return res.json(await projectPayload(req.userId, project.id));

  const generated = await runGeneration(req, project, prompt);
  if (!generated.ok) {
    // O projeto fica de pé mesmo com a geração falhando: o usuário reformula o
    // pedido no chat em vez de recomeçar do zero.
    return res.status(generated.status || 502).json({
      error: generated.error,
      project: await projectPayload(req.userId, project.id),
    });
  }
  res.json(await projectPayload(req.userId, project.id));
});

router.get('/design/projects/:id', async (req, res) => {
  const project = await requireProject(req, res);
  if (!project) return;
  res.json({
    ...(await projectPayload(req.userId, project.id)),
    versions: await listVersions(req.userId, project.id),
    messages: await listMessages(req.userId, project.id),
  });
});

router.patch('/design/projects/:id', validate(schemas.designProjectUpdate), async (req, res) => {
  const project = await requireProject(req, res);
  if (!project) return;
  const designSystemId = req.body.designSystemId;
  if (designSystemId && !await getDesignSystem(req.userId, designSystemId)) {
    return res.status(400).json({ error: 'Design system não encontrado.' });
  }
  await updateProject(req.userId, project.id, {
    title: req.body.title,
    designSystemId: designSystemId === undefined ? undefined : (designSystemId || null),
  });
  res.json(await projectPayload(req.userId, project.id));
});

router.delete('/design/projects/:id', async (req, res) => {
  const ok = await deleteProject(req.userId, req.params.id);
  if (!ok) return res.status(404).json(NOT_FOUND);
  res.json({ ok: true });
});

// Invalida a URL de preview e emite outra.
router.post('/design/projects/:id/preview-token', async (req, res) => {
  const token = await rotatePreviewToken(req.userId, req.params.id);
  if (!token) return res.status(404).json(NOT_FOUND);
  const project = await getProject(req.userId, req.params.id);
  res.json({ previewToken: token, previewUrl: previewUrl(project) });
});

// ---- Geração e refinamento --------------------------------------------------

// Caminho único de geração: monta o contexto, chama o modelo, valida o artefato,
// grava a versão e registra as duas falas no chat do projeto. Usado tanto pela
// criação com prompt quanto pelo /generate.
async function runGeneration(req, project, prompt) {
  const limitError = await enforceDailyLimit(req.userId);
  if (limitError) return { ok: false, status: 429, error: limitError };

  const designSystem = await getDesignSystem(req.userId, project.design_system_id);
  const version = await currentVersion(req.userId, project.id);
  const history = await listMessages(req.userId, project.id);

  const result = await generateArtifact({
    userId: req.userId,
    outputType: project.output_type,
    prompt,
    current: version?.content || '',
    designSystem,
    history,
    model: String(req.body?.model || ''),
  });

  // A fala do usuário é registrada mesmo quando a geração falha: sem ela, o
  // chat mostraria uma resposta de erro sem a pergunta que a causou.
  await addMessage(req.userId, project.id, 'user', prompt);
  if (!result.ok) {
    await addMessage(req.userId, project.id, 'assistant', result.error);
    return { ok: false, status: 502, error: result.error };
  }

  const created = await addVersion(req.userId, project.id, { content: result.content, promptUsed: prompt });
  await addMessage(
    req.userId, project.id, 'assistant',
    versionSummary(project.output_type, created.version_number, created.content),
    created.id,
  );

  if (result.usage) {
    await db.prepare(
      'INSERT INTO usage (id,user_id,conversation_id,assistant_id,model,kind,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(nanoid(), req.userId, null, null, result.model, 'design',
      result.usage.prompt_tokens || 0, result.usage.completion_tokens || 0, result.usage.total_tokens || 0, now());
  }

  return { ok: true, version: created };
}

router.post('/design/projects/:id/generate', validate(schemas.designGenerate), async (req, res) => {
  const project = await requireProject(req, res);
  if (!project) return;

  const result = await runGeneration(req, project, req.body.prompt);
  const payload = {
    ...(await projectPayload(req.userId, project.id)),
    versions: await listVersions(req.userId, project.id),
    messages: await listMessages(req.userId, project.id),
  };
  if (!result.ok) return res.status(result.status || 502).json({ error: result.error, ...payload });
  res.json(payload);
});

router.get('/design/projects/:id/messages', async (req, res) => {
  const project = await requireProject(req, res);
  if (!project) return;
  res.json(await listMessages(req.userId, project.id));
});

// ---- Versões ----------------------------------------------------------------

router.get('/design/projects/:id/versions', async (req, res) => {
  const project = await requireProject(req, res);
  if (!project) return;
  res.json(await listVersions(req.userId, project.id));
});

router.post('/design/projects/:id/revert', validate(schemas.designRevert), async (req, res) => {
  const project = await requireProject(req, res);
  if (!project) return;
  const version = await setCurrentVersion(req.userId, project.id, req.body.versionId);
  if (!version) return res.status(404).json({ error: 'Versão não encontrada.' });
  res.json({
    ...(await projectPayload(req.userId, project.id)),
    versions: await listVersions(req.userId, project.id),
  });
});

// ---- Preview ----------------------------------------------------------------

// Monta o HTML que o iframe renderiza. Para `slides` o HTML é NOSSO (o deck
// montado a partir do JSON); para `web`/`document` é o artefato do modelo.
function previewHtml(project, version) {
  if (!version) {
    return renderPlaceholder('Este projeto ainda não tem nenhuma versão. Descreva o que você quer no chat ao lado.');
  }
  // Conteúdo e tipo são colunas independentes: conferimos que combinam ANTES de
  // renderizar. Um JSON entregue como HTML (ou vice-versa) é o tipo de descasamento
  // que vira tela quebrada — ou pior, conteúdo interpretado fora do formato previsto.
  if (!contentMatchesType(version.content, project.output_type)) {
    return renderPlaceholder('O conteúdo desta versão não corresponde ao tipo do projeto e não foi renderizado.');
  }
  if (project.output_type === 'slides') {
    const parsed = parseSlidesJson(version.content);
    return renderSlidesDeck(parsed.slides, { title: project.title });
  }
  return version.content;
}

// Cabeçalhos que tornam o HTML gerado inofensivo para o app.
//
// `sandbox` no CSP é o ponto central: sem `allow-same-origin`, o documento roda
// numa ORIGEM OPACA — sem acesso a cookies, localStorage, IndexedDB ou ao DOM
// do app, mesmo servido do mesmo domínio e mesmo se alguém abrir a URL direto.
// O atributo sandbox do <iframe> no frontend repete a restrição; os dois juntos
// significam que esquecer um dos lados não abre o buraco sozinho.
function previewResponse(res, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', `sandbox allow-scripts; frame-ancestors ${FRAME_ANCESTORS}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // O X-Frame-Options do helmet (SAMEORIGIN) impediria o app de embutir o
  // preview quando ele é servido de DESIGN_PREVIEW_ORIGIN. Quem manda aqui é o
  // `frame-ancestors` acima, que é mais preciso e entende as duas origens.
  res.removeHeader('X-Frame-Options');
  res.send(html);
}

// Preview por token — SEM sessão (ver o cabeçalho deste arquivo).
router.get('/design/preview/:token', async (req, res) => {
  const project = await getProjectByToken(req.params.token);
  if (!project) return previewResponse(res.status(404), renderPlaceholder('Prévia não encontrada ou expirada.'));
  const version = await currentVersionByProjectId(project.id);
  previewResponse(res, previewHtml(project, version));
});

// Mesmo conteúdo, pela sessão do dono. Útil fora do navegador (testes, checagem
// rápida) sem precisar do token.
router.get('/design/projects/:id/preview', async (req, res) => {
  const project = await requireProject(req, res);
  if (!project) return;
  const version = await currentVersion(req.userId, project.id);
  previewResponse(res, previewHtml(project, version));
});

// ---- Exportação -------------------------------------------------------------

// HTML autocontido da versão escolhida — é também a base do PDF.
function exportableHtml(project, version) {
  if (project.output_type !== 'slides') return version.content;
  const parsed = parseSlidesJson(version.content);
  return renderSlidesDeck(parsed.slides, { title: project.title });
}

router.get('/design/projects/:id/export', async (req, res) => {
  const project = await requireProject(req, res);
  if (!project) return;

  // Exporta a versão pedida (ou a atual). Poder exportar uma versão antiga sem
  // ter de reverter o projeto é o que torna o histórico útil de verdade.
  const version = req.query.versionId
    ? await getVersion(req.userId, project.id, String(req.query.versionId))
    : await currentVersion(req.userId, project.id);
  if (!version) return res.status(404).json({ error: 'Não há nenhuma versão para exportar.' });
  if (!contentMatchesType(version.content, project.output_type)) {
    return res.status(409).json({ error: 'O conteúdo desta versão não corresponde ao tipo do projeto.' });
  }

  const format = resolveExportFormat(project.output_type, req.query.format);
  const fileName = safeFileName(project.title, format);
  const designSystem = await getDesignSystem(req.userId, project.design_system_id);

  if (format === 'pptx') {
    const parsed = parseSlidesJson(version.content);
    const buffer = await slidesToPptx(parsed.slides, { title: project.title, designSystem });
    if (!buffer) return res.status(503).json({ error: 'A exportação para PowerPoint não está disponível nesta instalação.' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(buffer);
  }

  const html = project.output_type === 'slides'
    ? renderSlidesDeck(parseSlidesJson(version.content).slides, { title: project.title, designSystem })
    : exportableHtml(project, version);

  if (format === 'pdf') {
    const pdf = await htmlToPdf(html, project.output_type);
    if (!pdf) return res.status(503).json({ error: 'A exportação em PDF não está disponível nesta instalação (navegador headless ausente).' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(pdf);
  }

  // O .html baixado é um arquivo, não uma página a ser aberta pelo servidor:
  // `attachment` + nosniff impedem que o navegador o renderize na origem do app.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(html);
});

// ---- Design systems ---------------------------------------------------------

router.get('/design/systems', async (req, res) => {
  res.json(await listDesignSystems(req.userId));
});

router.post('/design/systems', validate(schemas.designSystem), async (req, res) => {
  res.json(await createDesignSystem(req.userId, sanitizeDesignSystemInput(req.body)));
});

router.put('/design/systems/:id', validate(schemas.designSystem), async (req, res) => {
  const updated = await updateDesignSystem(req.userId, req.params.id, sanitizeDesignSystemInput(req.body));
  if (!updated) return res.status(404).json({ error: 'Design system não encontrado.' });
  res.json(updated);
});

router.delete('/design/systems/:id', async (req, res) => {
  const ok = await deleteDesignSystem(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Design system não encontrado.' });
  res.json({ ok: true });
});

export default router;
