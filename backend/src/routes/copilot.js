// Rotas do Copiloto — o "colega de trabalho" com espaço PRÓPRIO:
//   * um chat com contexto 100% isolado da conversa principal (memória separada);
//   * uma revisão de escrita de uma passada (usada pelo balão proativo do avatar);
//   * uma caixa de documentos independente dos anexos das conversas.
// A inteligência vem do provedor de IA já configurado pelo usuário — aqui só
// orquestramos o estado próprio do copiloto e a chamada isolada ao modelo.
import { nanoid } from 'nanoid';
import { makeRouter, safeParse } from './helpers.js';
import { db, now } from '../db.js';
import { getUserProvider } from '../userProvider.js';
import { openFreeTierGate } from '../freeTierGate.js';
import { sanitizeSettings } from './companion.js';
import { audit } from '../companion/audit.js';
import { decide, readPermissions } from '../companion/permissions.js';
import { normalizeScheduleDay, normalizeScheduleHour } from '../scheduling.js';
import {
  buildChatMessages, buildReviseMessages, buildSummaryMessages, estimateTokens,
  buildContextBlock, buildNotesBlock, buildKnowledgeBlock, decideContextAccess,
  sanitizeCharacterName, copilotModelRef, CONTEXT_ACCESS, RESPONSE_STYLES, TONES, NOTE_KINDS,
} from '../copilot/core.js';
import { findKnowledge } from '../copilot/knowledge.js';
import {
  buildExecutiveActionMessages, checkLgpdCompliance, reviewMemory,
  runSandboxAudit, suggestModelRouting,
} from '../copilot/executive.js';
import {
  ensureCopilotConversation, listCopilotMessages, appendCopilotMessage, clearCopilotConversation,
  createDocument, listDocuments, getDocument, deleteDocument,
  readPrefs, savePrefs, listNotes, createNote, updateNote, deleteNote, readMainChatTail,
} from '../copilot/store.js';

const router = makeRouter();

const NO_KEY_MSG = 'Nenhum provedor de IA configurado. Adicione uma chave em Configurações › Provedor de IA para conversar com o copiloto.';
const CALL_FAIL_MSG = 'Não consegui falar com o provedor de IA agora. Tente de novo em instantes.';

// Lê a configuração do Companion (compartilha a tabela companion_settings):
// o modelo do copiloto e o nome do personagem.
async function companionSettings(userId) {
  const row = await db.prepare('SELECT settings FROM companion_settings WHERE user_id=?').get(userId);
  return sanitizeSettings(row ? safeParse(row.settings, {}) : {});
}

async function resolveProvider(req) {
  const settings = await companionSettings(req.userId);
  return getUserProvider(req.userId, copilotModelRef(settings, req.body));
}

// Perfil do assistente escolhido como "Persona" no Companion (null = padrão).
// Escopado pelo dono: um id de outro usuário simplesmente não acha nada.
async function personaProfileFor(userId) {
  const { assistantId } = await companionSettings(userId);
  if (!assistantId) return null;
  const row = await db.prepare('SELECT system_prompt FROM assistants WHERE id=? AND user_id=?').get(String(assistantId), userId);
  return row?.system_prompt || null;
}

async function characterNameFor(userId) {
  return sanitizeCharacterName((await companionSettings(userId)).characterName);
}

// Extrai o texto de uma resposta de chat completion (compatível OpenAI).
function replyText(completion) {
  return String(completion?.choices?.[0]?.message?.content || '').trim();
}

// Aviso de fallback (Regra 5.5): o provedor pedido ficou sem chave utilizável e
// quem atendeu foi a chave da PLATAFORMA. Vai na resposta JSON para a interface
// mostrar — nunca uma troca silenciosa.
function fallbackNotice(provider) {
  if (!provider?.fallback) return {};
  return { providerFallback: { to: provider.fallback.to, reason: provider.fallback.reason, message: provider.fallback.message } };
}

// ÚNICO caminho do copiloto até o provedor de IA. Quando o provedor resolvido é
// a chave da PLATAFORMA (modo gratuito), passa pelos mesmos portões do /chat:
// limite/bloqueio ANTES da chamada (403/429 com `code`), vaga na fila,
// contabilidade do consumo e registro — ver freeTierGate.js. Antes, as quatro
// rotas chamavam o provedor gratuito direto, sem teto nem registro.
//
// Devolve `{ ok:true, text }` ou `{ ok:false, status, body }` pronto para a
// rota responder.
async function askModel(req, provider, { label, messages, temperature }) {
  let gate = null;
  if (provider.source === 'free') {
    gate = await openFreeTierGate({ userId: req.userId, model: provider.model, label: `copiloto:${label}` });
    if (!gate.ok) {
      const { ok: _ok, status, ...body } = gate;
      return { ok: false, status, body };
    }
  }
  let completion;
  try {
    completion = await provider.client.chat.completions.create({ model: provider.model, messages, temperature });
  } catch (err) {
    console.error(`[copilot] falha (${label}):`, err?.message);
    await gate?.failed(err);
    return { ok: false, status: 502, body: { error: CALL_FAIL_MSG } };
  } finally {
    gate?.release?.();
  }
  // A chamada chegou ao provedor: no modo gratuito ela CONTA, mesmo que a
  // resposta venha vazia — o consumo da chave da plataforma já ocorreu.
  await gate?.succeeded(completion);
  const text = replyText(completion);
  if (!text) return { ok: false, status: 502, body: { error: CALL_FAIL_MSG } };
  return { ok: true, text };
}

// ---- Chat isolado -----------------------------------------------------------

// Histórico do chat do copiloto (memória própria — nada da conversa principal).
router.get('/copilot/chat', async (req, res) => {
  const conv = await ensureCopilotConversation(req.userId);
  const messages = await listCopilotMessages(req.userId, conv.id);
  res.json({ conversationId: conv.id, messages });
});

// Reúne o que o copiloto pode ver ALÉM do próprio histórico, sempre por
// autorização: a memória que o usuário guardou, os verbetes do Studio que
// batem com a pergunta e — só quando permitido — o trecho do chat principal.
// Devolve também o que foi usado, para a interface poder mostrar sem mentir.
async function gatherContext(req, { prefs, text }) {
  const used = { notes: 0, knowledge: [], context: null };
  let notesBlock = null;
  let knowledgeBlock = null;
  let contextBlock = null;

  if (prefs.useNotes) {
    const notes = await listNotes(req.userId, { limit: 30 });
    notesBlock = buildNotesBlock(notes);
    if (notesBlock) used.notes = notes.length;
  }

  if (prefs.useKnowledge) {
    const hits = findKnowledge(text);
    knowledgeBlock = buildKnowledgeBlock(hits);
    if (knowledgeBlock) used.knowledge = hits.map(h => h.title);
  }

  // Tri-estado: true pede o contexto, false dispensa nesta mensagem e ausente
  // segue a preferência. Coagir para booleano aqui apagaria a diferença entre
  // "não quero desta vez" e "não disse nada".
  const raw = req.body?.shareContext;
  const requested = typeof raw === 'boolean' ? raw : undefined;
  const decision = decideContextAccess(prefs, requested);
  const conversationId = String(req.body?.conversationId || '').trim();
  if (decision.allowed && conversationId) {
    const tail = await readMainChatTail(req.userId, conversationId, prefs.contextMessages);
    const block = buildContextBlock(tail.messages, { maxMessages: prefs.contextMessages });
    if (block) {
      contextBlock = block.text;
      used.context = { messages: block.used, conversationTitle: tail.conversation?.title || null, truncated: block.truncated };
      // Ler a conversa principal é justamente o poder novo do copiloto: fica
      // registrado, com quantas mensagens e sob qual autorização.
      await audit(req.userId, {
        actor: 'copiloto',
        category: 'ler',
        action: 'contexto do chat principal',
        target: conversationId,
        authorized: true,
        detail: `${block.used} mensagem(ns) — autorização: ${decision.reason}`,
      });
    }
  }
  return { notesBlock, knowledgeBlock, contextBlock, used, decision };
}

// Envia uma mensagem ao copiloto e recebe a resposta.
//
// O isolamento continua sendo o padrão: sem `shareContext` (ou com o acesso em
// "nunca"), nada da conversa principal entra aqui. Quando o usuário autoriza,
// o trecho entra como bloco de REFERÊNCIA marcado — nunca como instrução.
router.post('/copilot/chat', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Mensagem vazia.' });

  const provider = await resolveProvider(req);
  if (!provider.hasKey || !provider.client) return res.status(400).json({ error: NO_KEY_MSG });

  const prefs = await readPrefs(req.userId);
  const conv = await ensureCopilotConversation(req.userId);
  const history = await listCopilotMessages(req.userId, conv.id);
  const { notesBlock, knowledgeBlock, contextBlock, used } = await gatherContext(req, { prefs, text });
  const messages = buildChatMessages(history, text, {
    prefs, notes: notesBlock, knowledge: knowledgeBlock, context: contextBlock,
    characterName: await characterNameFor(req.userId),
    personaProfile: await personaProfileFor(req.userId),
  });

  const reply = await askModel(req, provider, { label: 'chat', messages, temperature: 0.4 });
  if (!reply.ok) return res.status(reply.status).json(reply.body);
  const answer = reply.text;

  // Só persiste depois de uma resposta válida (evita mensagens órfãs).
  const userMsg = await appendCopilotMessage(req.userId, conv.id, 'user', text);
  const botMsg = await appendCopilotMessage(req.userId, conv.id, 'assistant', answer);
  res.json({ conversationId: conv.id, userMessage: userMsg, message: botMsg, used, ...fallbackNotice(provider) });
});

// Limpa o histórico do copiloto (recomeçar).
router.delete('/copilot/chat', async (req, res) => {
  const conv = await ensureCopilotConversation(req.userId);
  await clearCopilotConversation(req.userId, conv.id);
  res.json({ ok: true, conversationId: conv.id });
});

// ---- Preferências do painel -------------------------------------------------

// O front não precisa duplicar as listas de opções — elas vêm daqui.
router.get('/copilot/prefs', async (req, res) => {
  res.json({
    prefs: await readPrefs(req.userId),
    options: { contextAccess: CONTEXT_ACCESS, responseStyles: RESPONSE_STYLES, tones: TONES, noteKinds: NOTE_KINDS },
  });
});

router.put('/copilot/prefs', async (req, res) => {
  const before = await readPrefs(req.userId);
  const prefs = await savePrefs(req.userId, req.body || {});
  // Mudar quem pode ler a conversa principal é decisão de privacidade: fica no
  // log mesmo quando o resultado é "fechar a porta".
  if (before.contextAccess !== prefs.contextAccess) {
    await audit(req.userId, {
      actor: 'usuario', category: 'alterar', action: 'acesso do copiloto ao chat principal',
      authorized: true, level: prefs.contextAccess === 'sempre' ? 'aviso' : 'info',
      detail: `${before.contextAccess} → ${prefs.contextAccess}`,
    });
  }
  res.json({ prefs });
});

// ---- Memória própria do copiloto --------------------------------------------

router.get('/copilot/notes', async (req, res) => {
  res.json(await listNotes(req.userId));
});

router.post('/copilot/notes', async (req, res) => {
  const note = await createNote(req.userId, req.body || {});
  if (!note) return res.status(400).json({ error: 'Escreva o conteúdo da nota.' });
  res.json(note);
});

router.patch('/copilot/notes/:id', async (req, res) => {
  const note = await updateNote(req.userId, req.params.id, req.body || {});
  if (!note) return res.status(404).json({ error: 'Não encontrado' });
  res.json(note);
});

router.delete('/copilot/notes/:id', async (req, res) => {
  const ok = await deleteNote(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ ok: true });
});

// ---- Ações do copiloto dentro do Studio -------------------------------------
// São ações DETERMINÍSTICAS, disparadas por um clique do usuário sobre um
// conteúdo que ele está vendo — o modelo não as executa por conta própria.

// Salva um texto como template de pedido (o mesmo acervo do compositor do chat
// principal): é assim que uma sugestão do copiloto vira ferramenta reutilizável.
router.post('/copilot/actions/template', async (req, res) => {
  const content = String(req.body?.content || '').trim();
  const name = String(req.body?.name || '').trim().slice(0, 120) || 'Modelo do copiloto';
  if (!content) return res.status(400).json({ error: 'Nada para salvar.' });
  const id = nanoid();
  await db.prepare('INSERT INTO templates (id,user_id,name,content,created_at) VALUES (?,?,?,?,?)')
    .run(id, req.userId, name, content.slice(0, 20_000), now());
  await audit(req.userId, {
    actor: 'copiloto', category: 'alterar', action: 'salvar modelo de pedido',
    target: name, authorized: true, result: 'criado',
  });
  res.json({ id, name, content });
});

// Resume a conversa do copiloto e guarda o resultado na caixa de documentos.
router.post('/copilot/actions/summary', async (req, res) => {
  const provider = await resolveProvider(req);
  if (!provider.hasKey || !provider.client) return res.status(400).json({ error: NO_KEY_MSG });

  const conv = await ensureCopilotConversation(req.userId);
  const history = await listCopilotMessages(req.userId, conv.id);
  if (history.length < 2) return res.status(400).json({ error: 'A conversa ainda é curta demais para resumir.' });

  const reply = await askModel(req, provider, { label: 'resumo', messages: buildSummaryMessages(history), temperature: 0.2 });
  if (!reply.ok) return res.status(reply.status).json(reply.body);
  const summary = reply.text;

  const document = await createDocument(req.userId, {
    kind: 'relatorio',
    name: `Resumo da conversa — ${new Date().toLocaleString('pt-BR')}`,
    mime: 'text/markdown',
    content: summary,
    meta: { origem: 'acao_resumo', mensagens: history.length },
  });
  res.json({ summary, document, ...fallbackNotice(provider) });
});

// ---- Ferramentas executivas exclusivas do Nino ------------------------------

async function authorizedContent(req) {
  const documentId = String(req.body?.documentId || '').trim();
  if (documentId) {
    const document = await getDocument(req.userId, documentId);
    return document ? { content: document.content || '', name: document.name, mime: document.mime } : null;
  }
  return {
    content: String(req.body?.content ?? req.body?.text ?? '').slice(0, 200_000),
    name: String(req.body?.name || '').slice(0, 200),
    mime: String(req.body?.mime || '').slice(0, 100),
  };
}

router.post('/copilot/tools/lgpd-check', async (req, res) => {
  const input = await authorizedContent(req);
  if (!input) return res.status(404).json({ error: 'Documento não encontrado.' });
  if (!input.content) return res.status(400).json({ error: 'Informe conteúdo ou documentId para analisar.' });
  const result = checkLgpdCompliance(input);
  await audit(req.userId, { actor: 'copiloto', category: 'consultar', action: 'check_lgpd_compliance', authorized: true, level: result.status === 'bloquear' ? 'critico' : result.status === 'revisar' ? 'aviso' : 'info', detail: `${result.total} ocorrência(s); valores não registrados` });
  res.json(result);
});

router.post('/copilot/tools/sandbox-audit', async (req, res) => {
  const input = await authorizedContent(req);
  if (!input) return res.status(404).json({ error: 'Documento não encontrado.' });
  const result = runSandboxAudit(input);
  await audit(req.userId, { actor: 'copiloto', category: 'consultar', action: 'run_sandbox_audit', target: input.name || 'conteúdo colado', authorized: true, level: result.status === 'reprovado' ? 'aviso' : 'info', detail: `${result.scope}; ${result.issues.length} achado(s)` });
  res.json(result);
});

router.post('/copilot/tools/model-routing', async (req, res) => {
  const result = suggestModelRouting(req.body || {});
  await audit(req.userId, { actor: 'copiloto', category: 'consultar', action: 'suggest_model_routing', authorized: true, level: 'info', detail: `${result.tier}; complexidade ${result.complexityScore}` });
  res.json(result);
});

router.post('/copilot/tools/memory-review', async (req, res) => {
  const notes = await listNotes(req.userId, { limit: 200 });
  const result = reviewMemory(notes);
  await audit(req.userId, { actor: 'copiloto', category: 'consultar', action: 'auditar memória', authorized: true, level: result.sensitive.length ? 'aviso' : 'info', detail: `${result.duplicates.length} duplicata(s); ${result.sensitive.length} nota(s) sensível(is)` });
  res.json(result);
});

router.post('/copilot/tools/auto-routine', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  const prompt = String(b.prompt || '').trim().slice(0, 100_000);
  const cadence = ['daily', 'weekly', 'monthly'].includes(b.cadence) ? b.cadence : 'weekly';
  const preview = { title, prompt, cadence, day: normalizeScheduleDay(cadence, b.day), hour: normalizeScheduleHour(b.hour) };
  const assistantId = b.assistantId ? String(b.assistantId).slice(0, 64) : null;
  const model = b.model ? String(b.model).slice(0, 200) : null;
  const clientId = b.clientId ? String(b.clientId).slice(0, 64) : null;
  if (!title || !prompt) return res.status(400).json({ error: 'Título e instrução da rotina são obrigatórios.' });
  if (b.confirmed !== true) return res.status(409).json({ error: 'Confirmação explícita necessária.', requiresConfirmation: true, preview });
  const perms = await readPermissions(req.userId);
  const decision = decide(perms, 'criar_rotinas');
  if (!decision.allowed) return res.status(403).json({ error: decision.reason, decision });
  const id = nanoid();
  await db.prepare('INSERT INTO schedules (id,user_id,title,prompt,assistant_id,model,client_id,web_search,cadence,day,hour,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, title, prompt, assistantId, model, clientId, b.webSearch ? 1 : 0, cadence, preview.day, preview.hour, 1, now());
  await audit(req.userId, { actor: 'copiloto', category: 'alterar', action: 'trigger_auto_routine', target: title, authorized: true, permLevel: perms.level, level: 'aviso', detail: `${cadence}; ${preview.hour}` });
  res.json(await db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').get(id, req.userId));
});

router.post('/copilot/tools/executive-action', async (req, res) => {
  const action = String(req.body?.action || '');
  const content = String(req.body?.content || '').trim();
  if (!['logic-review', 'optimize-prompt'].includes(action)) return res.status(400).json({ error: 'Ação executiva inválida.' });
  if (!content) return res.status(400).json({ error: 'Informe o conteúdo para analisar.' });
  const provider = await resolveProvider(req);
  if (!provider.hasKey || !provider.client) return res.status(400).json({ error: NO_KEY_MSG });
  const reply = await askModel(req, provider, {
    label: `acao:${action}`,
    messages: buildExecutiveActionMessages(action, content, { characterName: await characterNameFor(req.userId) }),
    temperature: 0.2,
  });
  if (!reply.ok) return res.status(reply.status).json(reply.body);
  await audit(req.userId, { actor: 'copiloto', category: 'consultar', action, authorized: true, level: 'info', detail: 'conteúdo não registrado no log' });
  res.json({ action, result: reply.text, ...fallbackNotice(provider) });
});

// ---- Revisão de escrita (balão proativo do avatar) --------------------------

// Recebe o rascunho e devolve a versão revisada (ortografia/gramática/clareza),
// guardando também uma cópia na caixa de documentos do copiloto. Não toca no
// chat nem na conversa principal.
router.post('/copilot/revise', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Nada para revisar.' });

  const provider = await resolveProvider(req);
  if (!provider.hasKey || !provider.client) return res.status(400).json({ error: NO_KEY_MSG });

  const reply = await askModel(req, provider, { label: 'revisao', messages: buildReviseMessages(text), temperature: 0.2 });
  if (!reply.ok) return res.status(reply.status).json(reply.body);
  const revised = reply.text;

  let document = null;
  try {
    document = await createDocument(req.userId, {
      kind: 'texto_revisado',
      name: `Texto revisado — ${new Date().toLocaleString('pt-BR')}`,
      mime: 'text/plain',
      content: revised,
      meta: { origem: 'balao_escrita', tokensOriginais: estimateTokens(text) },
    });
  } catch (err) {
    console.error('[copilot] não guardei o texto revisado:', err?.message);
  }
  res.json({ revised, document, ...fallbackNotice(provider) });
});

// ---- Caixa de documentos ----------------------------------------------------

router.get('/copilot/documents', async (req, res) => {
  res.json(await listDocuments(req.userId, { kind: req.query.kind || null }));
});

router.post('/copilot/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.content && !b.name) return res.status(400).json({ error: 'content ou name é obrigatório.' });
  res.json(await createDocument(req.userId, b));
});

router.get('/copilot/documents/:id', async (req, res) => {
  const doc = await getDocument(req.userId, req.params.id, { withContent: true });
  if (!doc) return res.status(404).json({ error: 'Não encontrado' });
  res.json(doc);
});

// Download do documento como arquivo de texto.
router.get('/copilot/documents/:id/download', async (req, res) => {
  const doc = await getDocument(req.userId, req.params.id, { withContent: true });
  if (!doc) return res.status(404).json({ error: 'Não encontrado' });
  const ext = doc.mime === 'text/markdown' ? 'md' : 'txt';
  const safeName = String(doc.name || 'documento').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  res.setHeader('Content-Type', `${doc.mime || 'text/plain'}; charset=utf-8`);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
  res.send(doc.content || '');
});

router.delete('/copilot/documents/:id', async (req, res) => {
  const ok = await deleteDocument(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ ok: true });
});

export default router;
