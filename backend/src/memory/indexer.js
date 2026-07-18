import OpenAI from 'openai';
import { db, now } from '../db.js';
import { nanoid } from 'nanoid';
import { embed } from './embeddings.js';
import { getSettings, addMemory, addMemorySuggestion, findSimilar, looksSensitive } from './memoryService.js';
import { getUserProvider } from '../userProvider.js';

// Indexa conversas (chunks + resumo) e extrai fatos importantes para a
// memória de longo prazo. Roda em segundo plano, sem atrasar as respostas.

let _client = null;
function client() {
  if (!_client) _client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY || 'sem-chave',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  });
  return _client;
}
// Fallback coerente com a base URL: OpenRouter usa ids com barra; a API
// nativa da DeepSeek usa 'deepseek-chat'.
const EXTRACT_MODEL = () => process.env.EXTRACT_MODEL || process.env.DEEPSEEK_MODEL ||
  ((process.env.DEEPSEEK_BASE_URL || '').includes('openrouter') ? 'deepseek/deepseek-chat' : 'deepseek-chat');

export const estimateTokens = (s) => Math.ceil(String(s || '').length / 3.5);

const EXTRACT_PROMPT = `Você é o módulo de memória de um assistente. Analise o trecho de conversa e devolva APENAS um JSON válido, sem comentários, no formato:
{
  "summary_short": "resumo da conversa em 1 frase",
  "summary_long": "resumo em até 5 frases (ou null se a conversa for curta)",
  "tags": ["até", "5", "tags"],
  "facts": [
    { "content": "fato conciso e autossuficiente sobre o usuário/projeto", "type": "perfil|preferencia|projeto|fato", "importance": 1-5, "confidence": 0.0-1.0 }
  ]
}
Regras para facts:
- Salve apenas o que for útil no FUTURO: identidade (nome, profissão, registro), preferências de resposta/formato, projetos em andamento, decisões tomadas, pendências.
- Escreva cada fato de forma independente (ex.: "O usuário prefere respostas curtas e diretas").
- NÃO salve: dados temporários, senhas/chaves/tokens, conteúdo ambíguo, detalhes sem valor futuro.
- Se não houver nada digno de memória, devolva "facts": [].`;

function parseJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('sem JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Chamado após cada resposta do assistente (fire-and-forget)
export async function indexAfterReply(userId, conversationId) {
  const s = getSettings();
  if (!s.memory_enabled) return;
  const conv = await db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId);
  if (!conv) return;
  const msgs = await db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC, seq ASC').all(conversationId);
  if (msgs.length < 2) return;

  // 1) Chunk do último par pergunta/resposta (para busca semântica futura)
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  const lastAsst = [...msgs].reverse().find(m => m.role === 'assistant');
  if (lastUser && lastAsst) {
    const content = `Usuário: ${lastUser.content.slice(0, 1100)}\nAssistente: ${lastAsst.content.slice(0, 1100)}`;
    const [vec] = await embed([content], 'passage');
    const chunkScope = conv.client_id ? `client:${conv.client_id}` : 'global';
    await db.prepare('INSERT INTO conversation_chunks (id, user_id, conversation_id, source_title, scope, content, embedding, token_count, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(nanoid(), userId, conversationId, conv.title, chunkScope, content, vec, estimateTokens(content), now());
  }

  // 2) Resumo + extração de fatos (uma chamada de LLM). No modo economia, roda
  // só a cada 4 mensagens (em vez de a cada resposta) — o chunk acima, que é
  // local/grátis, continua sendo salvo sempre.
  if (!s.auto_memory) return;
  if (s.economy_mode && msgs.length % 4 !== 0) return;
  // BYOK: a extração de fatos (LLM) usa a chave do próprio usuário; sem chave,
  // pula a extração (o chunk local acima, grátis, já foi salvo).
  const provider = await getUserProvider(userId);
  if (!provider.client) return;
  try {
    const recent = msgs.slice(-6).map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content.slice(0, 700)}`).join('\n');
    const input = `Resumo atual da conversa: ${conv.summary_short || '(nenhum)'}\nTotal de mensagens: ${msgs.length}\n\nTrecho recente:\n${recent}`;
    const completion = await provider.client.chat.completions.create({
      model: EXTRACT_MODEL(),
      messages: [{ role: 'system', content: EXTRACT_PROMPT }, { role: 'user', content: input }],
      temperature: 0
    });
    const data = parseJson(completion.choices[0].message.content);

    if (data.summary_short) {
      await db.prepare('UPDATE conversations SET summary_short=?, tags=? WHERE id=? AND user_id=?')
        .run(String(data.summary_short).slice(0, 300), JSON.stringify(data.tags || []).slice(0, 300), conversationId, userId);
    }
    if (data.summary_long && msgs.length >= 8) {
      await db.prepare('UPDATE conversations SET summary_long=? WHERE id=? AND user_id=?').run(String(data.summary_long).slice(0, 1500), conversationId, userId);
    }

    const clientScope = conv.client_id ? `client:${conv.client_id}` : 'global';
    for (const f of (data.facts || []).slice(0, 6)) {
      const content = String(f.content || '').trim();
      const importance = Math.min(5, Math.max(1, Number(f.importance) || 3));
      const confidence = Math.min(1, Math.max(0, Number(f.confidence) || 0.5));
      if (!content || content.length < 8) continue;
      if (looksSensitive(content)) continue;                      // nunca salvar segredos
      if (confidence < 0.6 || importance < s.importance_threshold) continue;
      const type = ['perfil', 'preferencia', 'projeto', 'fato'].includes(f.type) ? f.type : 'fato';
      // Numa conversa de um cliente específico, TUDO fica no escopo do cliente —
      // inclusive preferências (senão a preferência do cliente A vazaria para os
      // outros). Só vira 'global' quando a conversa não tem cliente.
      const isClient = clientScope && clientScope !== 'global';
      const scope = isClient ? clientScope : ((type === 'perfil' || type === 'preferencia') ? 'global' : clientScope);
      const dup = await findSimilar(userId, content, 0.88, scope);
      if (dup) {
        await db.prepare('UPDATE memory SET importance=GREATEST(importance,?), updated_at=? WHERE id=? AND user_id=?').run(importance, now(), dup.id, userId);
        continue;
      }
      if (s.review_auto_memory) await addMemorySuggestion(userId, { content, type, scope, importance, confidence, source_type: 'auto', source_id: conversationId });
      else await addMemory(userId, { content, type, scope, importance, confidence, source_type: 'auto', source_id: conversationId });
    }
  } catch (err) {
    console.error('[memória] extração falhou (segue sem):', err.message);
  }
}

// ---- Importação de conversas antigas (.json ChatGPT/Claude, .txt, .md, .html) ----
function stripHtml(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// Extrai [{title, text}] dos formatos conhecidos
function parseImport(name, text) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'json') {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : [data];
    const convs = [];
    for (const item of arr) {
      // Export do Claude: { name/title, chat_messages: [{sender, text}] }
      if (Array.isArray(item.chat_messages)) {
        const body = item.chat_messages.map(m => `${m.sender === 'human' ? 'Usuário' : 'Assistente'}: ${m.text || ''}`).join('\n');
        convs.push({ title: item.name || item.title || 'Conversa importada', text: body });
        continue;
      }
      // Export do ChatGPT: { title, mapping: { id: { message: { author, content: { parts } } } } }
      if (item.mapping && typeof item.mapping === 'object') {
        const parts = [];
        for (const node of Object.values(item.mapping)) {
          const msg = node?.message;
          const role = msg?.author?.role;
          const txt = (msg?.content?.parts || []).filter(p => typeof p === 'string').join('\n').trim();
          if (txt && (role === 'user' || role === 'assistant')) parts.push(`${role === 'user' ? 'Usuário' : 'Assistente'}: ${txt}`);
        }
        if (parts.length) convs.push({ title: item.title || 'Conversa importada', text: parts.join('\n') });
        continue;
      }
      // Genérico: { title, messages: [{role, content}] }
      if (Array.isArray(item.messages)) {
        const body = item.messages.map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
        convs.push({ title: item.title || 'Conversa importada', text: body });
      }
    }
    if (convs.length) return convs;
    throw new Error('JSON não reconhecido (esperado export do Claude, do ChatGPT ou {title, messages}).');
  }
  const raw = ext === 'html' || ext === 'htm' ? stripHtml(text) : text;
  return [{ title: name.replace(/\.[a-z]+$/i, ''), text: String(raw) }];
}

// Estado da importação (consultado pela interface para mostrar progresso)
export const importStatus = { running: false, file: '', scope: 'global', total: 0, processed: 0, chunks: 0, facts: 0, error: null, done: false };

function normalizeImportScope(scope) {
  const s = String(scope || 'global');
  if (s === 'global' || s === 'office' || s.startsWith('client:')) return s;
  return 'global';
}

// Inicia a importação em SEGUNDO PLANO (a rota responde na hora)
export function startImport(userId, fileName, buffer, scope = 'global') {
  if (importStatus.running) return { ok: false, error: 'Já existe uma importação em andamento.' };
  const targetScope = normalizeImportScope(scope);
  Object.assign(importStatus, { running: true, file: fileName, scope: targetScope, total: 0, processed: 0, chunks: 0, facts: 0, error: null, done: false });
  importConversations(userId, fileName, buffer, targetScope)
    .then(r => Object.assign(importStatus, { running: false, done: true, ...r }))
    .catch(err => Object.assign(importStatus, { running: false, done: true, error: err.message }));
  return { ok: true };
}

export async function importConversations(userId, fileName, buffer, scope = 'global') {
  const targetScope = normalizeImportScope(scope);
  const provider = await getUserProvider(userId);          // BYOK p/ extração de fatos
  const text = buffer.toString('utf8');
  const convs = parseImport(fileName, text).slice(0, 200);
  importStatus.total = convs.length;
  let chunks = 0, facts = 0;
  for (const conv of convs) {
    importStatus.processed++;
    importStatus.chunks = chunks;
    importStatus.facts = facts;
    console.log(`[memória] importando ${importStatus.processed}/${convs.length}: ${String(conv.title).slice(0, 60)}`);
    const title = `Importada: ${String(conv.title).slice(0, 80)}`;
    // divide em janelas de ~1400 caracteres
    const body = String(conv.text || '').trim();
    if (!body) continue;
    const pieces = [];
    for (let i = 0; i < body.length && pieces.length < 400; i += 1400) pieces.push(body.slice(i, i + 1500));
    for (let i = 0; i < pieces.length; i += 16) {
      const batch = pieces.slice(i, i + 16);
      const vecs = await embed(batch, 'passage');
      for (let j = 0; j < batch.length; j++) {
        await db.prepare('INSERT INTO conversation_chunks (id, user_id, conversation_id, source_title, scope, content, embedding, token_count, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(nanoid(), userId, null, title, targetScope, batch[j], vecs[j], estimateTokens(batch[j]), now());
        chunks++;
      }
    }
    // colhe fatos do começo da conversa importada (perfil, preferências...)
    if (!provider.client) continue;                        // sem chave: só os chunks (grátis)
    try {
      const completion = await provider.client.chat.completions.create({
        model: EXTRACT_MODEL(),
        messages: [{ role: 'system', content: EXTRACT_PROMPT }, { role: 'user', content: `Conversa importada "${conv.title}":\n${body.slice(0, 5000)}` }],
        temperature: 0
      });
      const data = parseJson(completion.choices[0].message.content);
      for (const f of (data.facts || []).slice(0, 5)) {
        const content = String(f.content || '').trim();
        if (!content || looksSensitive(content) || (Number(f.confidence) || 0) < 0.6) continue;
        const dup = await findSimilar(userId, content, 0.88, targetScope);
        if (dup) continue;
        const type = ['perfil', 'preferencia', 'projeto', 'fato'].includes(f.type) ? f.type : 'fato';
        const payload = { content, type, scope: targetScope, importance: Math.min(5, Number(f.importance) || 3), confidence: Number(f.confidence) || 0.7, source_type: 'import', source_id: title };
        if (getSettings().review_auto_memory) await addMemorySuggestion(userId, payload);
        else await addMemory(userId, payload);
        facts++;
      }
    } catch {}
  }
  importStatus.chunks = chunks;
  importStatus.facts = facts;
  return { conversations: convs.length, chunks, facts };
}
