// Rotas do Copiloto — o "colega de trabalho" com espaço PRÓPRIO:
//   * um chat com contexto 100% isolado da conversa principal (memória separada);
//   * uma revisão de escrita de uma passada (usada pelo balão proativo do avatar);
//   * uma caixa de documentos independente dos anexos das conversas.
// A inteligência vem do provedor de IA já configurado pelo usuário — aqui só
// orquestramos o estado próprio do copiloto e a chamada isolada ao modelo.
import { makeRouter, safeParse } from './helpers.js';
import { db } from '../db.js';
import { getUserProvider } from '../userProvider.js';
import { sanitizeSettings } from './companion.js';
import {
  buildChatMessages, buildReviseMessages, estimateTokens,
} from '../copilot/core.js';
import {
  ensureCopilotConversation, listCopilotMessages, appendCopilotMessage, clearCopilotConversation,
  createDocument, listDocuments, getDocument, deleteDocument,
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

// Envia uma mensagem ao copiloto e recebe a resposta. As mensagens enviadas ao
// modelo são montadas SÓ com o histórico do copiloto (isolamento garantido em
// buildChatMessages) + a persona dedicada.
router.post('/copilot/chat', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Mensagem vazia.' });

  const provider = await resolveProvider(req.userId);
  if (!provider.hasKey || !provider.client) return res.status(400).json({ error: NO_KEY_MSG });

  const conv = await ensureCopilotConversation(req.userId);
  const history = await listCopilotMessages(req.userId, conv.id);
  const messages = buildChatMessages(history, text);

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
  res.json({ conversationId: conv.id, userMessage: userMsg, message: botMsg });
});

// Limpa o histórico do copiloto (recomeçar).
router.delete('/copilot/chat', async (req, res) => {
  const conv = await ensureCopilotConversation(req.userId);
  await clearCopilotConversation(req.userId, conv.id);
  res.json({ ok: true, conversationId: conv.id });
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
