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
import { sanitizeSettings } from './companion.js';
import { audit } from '../companion/audit.js';
import {
  buildChatMessages, buildReviseMessages, buildSummaryMessages, estimateTokens,
  buildContextBlock, buildNotesBlock, buildKnowledgeBlock, decideContextAccess,
  CONTEXT_ACCESS, RESPONSE_STYLES, TONES, NOTE_KINDS,
} from '../copilot/core.js';
import { findKnowledge } from '../copilot/knowledge.js';
import {
  ensureCopilotConversation, listCopilotMessages, appendCopilotMessage, clearCopilotConversation,
  createDocument, listDocuments, getDocument, deleteDocument,
  readPrefs, savePrefs, listNotes, createNote, updateNote, deleteNote, readMainChatTail,
} from '../copilot/store.js';

const router = makeRouter();

const NO_KEY_MSG = 'Nenhum provedor de IA configurado. Adicione uma chave em Configurações › Provedor de IA para conversar com o copiloto.';
const CALL_FAIL_MSG = 'Não consegui falar com o provedor de IA agora. Tente de novo em instantes.';

// Lê a configuração do Companion (compartilha a tabela companion_settings) só
// para saber qual modelo o copiloto deve usar.
async function copilotModelRef(userId) {
  const row = await db.prepare('SELECT settings FROM companion_settings WHERE user_id=?').get(userId);
  const settings = sanitizeSettings(row ? safeParse(row.settings, {}) : {});
  return settings.model || '';
}

async function resolveProvider(userId) {
  const ref = await copilotModelRef(userId);
  return getUserProvider(userId, ref);
}

// Extrai o texto de uma resposta de chat completion (compatível OpenAI).
function replyText(completion) {
  return String(completion?.choices?.[0]?.message?.content || '').trim();
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

  const requested = req.body?.shareContext === true;
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

  const provider = await resolveProvider(req.userId);
  if (!provider.hasKey || !provider.client) return res.status(400).json({ error: NO_KEY_MSG });

  const prefs = await readPrefs(req.userId);
  const conv = await ensureCopilotConversation(req.userId);
  const history = await listCopilotMessages(req.userId, conv.id);
  const { notesBlock, knowledgeBlock, contextBlock, used } = await gatherContext(req, { prefs, text });
  const messages = buildChatMessages(history, text, {
    prefs, notes: notesBlock, knowledge: knowledgeBlock, context: contextBlock,
  });

  let answer = '';
  try {
    const completion = await provider.client.chat.completions.create({
      model: provider.model,
      messages,
      temperature: 0.4,
    });
    answer = replyText(completion);
  } catch (err) {
    console.error('[copilot] falha no chat:', err?.message);
    return res.status(502).json({ error: CALL_FAIL_MSG });
  }
  if (!answer) return res.status(502).json({ error: CALL_FAIL_MSG });

  // Só persiste depois de uma resposta válida (evita mensagens órfãs).
  const userMsg = await appendCopilotMessage(req.userId, conv.id, 'user', text);
  const botMsg = await appendCopilotMessage(req.userId, conv.id, 'assistant', answer);
  res.json({ conversationId: conv.id, userMessage: userMsg, message: botMsg, used });
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
  const provider = await resolveProvider(req.userId);
  if (!provider.hasKey || !provider.client) return res.status(400).json({ error: NO_KEY_MSG });

  const conv = await ensureCopilotConversation(req.userId);
  const history = await listCopilotMessages(req.userId, conv.id);
  if (history.length < 2) return res.status(400).json({ error: 'A conversa ainda é curta demais para resumir.' });

  let summary = '';
  try {
    const completion = await provider.client.chat.completions.create({
      model: provider.model,
      messages: buildSummaryMessages(history),
      temperature: 0.2,
    });
    summary = replyText(completion);
  } catch (err) {
    console.error('[copilot] falha no resumo:', err?.message);
    return res.status(502).json({ error: CALL_FAIL_MSG });
  }
  if (!summary) return res.status(502).json({ error: CALL_FAIL_MSG });

  const document = await createDocument(req.userId, {
    kind: 'relatorio',
    name: `Resumo da conversa — ${new Date().toLocaleString('pt-BR')}`,
    mime: 'text/markdown',
    content: summary,
    meta: { origem: 'acao_resumo', mensagens: history.length },
  });
  res.json({ summary, document });
});

// ---- Revisão de escrita (balão proativo do avatar) --------------------------

// Recebe o rascunho e devolve a versão revisada (ortografia/gramática/clareza),
// guardando também uma cópia na caixa de documentos do copiloto. Não toca no
// chat nem na conversa principal.
router.post('/copilot/revise', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Nada para revisar.' });

  const provider = await resolveProvider(req.userId);
  if (!provider.hasKey || !provider.client) return res.status(400).json({ error: NO_KEY_MSG });

  let revised = '';
  try {
    const completion = await provider.client.chat.completions.create({
      model: provider.model,
      messages: buildReviseMessages(text),
      temperature: 0.2,
    });
    revised = replyText(completion);
  } catch (err) {
    console.error('[copilot] falha na revisão:', err?.message);
    return res.status(502).json({ error: CALL_FAIL_MSG });
  }
  if (!revised) return res.status(502).json({ error: CALL_FAIL_MSG });

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
  res.json({ revised, document });
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
