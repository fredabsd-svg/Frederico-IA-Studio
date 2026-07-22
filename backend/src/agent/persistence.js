// Persistência no banco: mensagens da conversa, resposta do assistente com os
// cartões de arquivo e a memória (escopo do cliente e notas de memória).
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).
import { db, now } from '../db.js';
import { nanoid } from 'nanoid';

// Memória: global (todos) + do assistente atual + do cliente da conversa
export async function clientScopeFor(userId, conversationId) {
  try {
    const conv = await db.prepare('SELECT client_id FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId);
    return conv?.client_id ? `client:${conv.client_id}` : null;
  } catch { return null; }
}

export async function memoryNote(userId, assistantId, clientScope) {
  const scopes = ['global'];
  if (assistantId) scopes.push(assistantId);
  if (clientScope) scopes.push(clientScope);
  let rows = [];
  try {
    const ph = scopes.map(() => '?').join(',');
    rows = await db.prepare(`SELECT scope, content FROM memory WHERE scope IN (${ph}) AND user_id=? ORDER BY created_at ASC`).all(...scopes, userId);
  } catch {}
  if (!rows.length) return null;
  const global = rows.filter(r => r.scope === 'global').map(r => `- ${r.content}`);
  const client = rows.filter(r => r.scope === clientScope && clientScope).map(r => `- ${r.content}`);
  const mine = rows.filter(r => r.scope === assistantId && assistantId).map(r => `- ${r.content}`);
  let out = '';
  if (global.length) out += `Informações permanentes sobre o usuário/empresa:\n${global.join('\n')}`;
  if (client.length) out += `${out ? '\n\n' : ''}Informações sobre o CLIENTE desta conversa:\n${client.join('\n')}`;
  if (mine.length) out += `${out ? '\n\n' : ''}Memória específica deste assistente:\n${mine.join('\n')}`;
  return out || null;
}

export async function saveMessage(userId, conversationId, role, content, extra = {}) {
  const id = nanoid();
  const memoryMeta = extra.memoryMeta ? JSON.stringify(extra.memoryMeta).slice(0, 20000) : null;
  // Execução multimodelo: resultado individual de cada modelo (função, status,
  // texto, tokens, custo) para a interface remontar os cartões ao reabrir.
  // Um .slice() cego quebraria o JSON; se passar do teto, regrava com os textos
  // individuais encurtados (o texto principal da mensagem continua íntegro).
  let multiMeta = null;
  const executionMeta = extra.executionMeta ? JSON.stringify(extra.executionMeta).slice(0, 20000) : null;
  if (extra.multiMeta) {
    multiMeta = JSON.stringify(extra.multiMeta);
    if (multiMeta.length > 200000) {
      // Encurta os campos volumosos: texto de cada modelo, o histórico por
      // rodada (debate) e a síntese do coordenador (council/debate). Antes só o
      // texto por modelo era cortado — um debate longo (N modelos × R rodadas)
      // podia estourar o teto pelo histórico e ficar sem efeito.
      const compact = {
        ...extra.multiMeta,
        synthesis: extra.multiMeta.synthesis
          ? { ...extra.multiMeta.synthesis, text: String(extra.multiMeta.synthesis.text || '').slice(0, 4000) }
          : undefined,
        models: (extra.multiMeta.models || []).map(m => ({
          ...m,
          text: String(m.text || '').slice(0, 4000),
          history: Array.isArray(m.history)
            ? m.history.map(h => ({ ...h, text: String(h.text || '').slice(0, 2000) }))
            : m.history
        }))
      };
      multiMeta = JSON.stringify(compact);
    }
  }
  await db.prepare('INSERT INTO messages (id, conversation_id, role, content, memory_meta, multi_meta, execution_meta, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, conversationId, role, content, memoryMeta, multiMeta, executionMeta, now());
  await db.prepare('UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?').run(now(), conversationId, userId);
  return id;
}

export async function persistAssistantReply(userId, conversationId, content, memoryMeta, files = [], extra = {}) {
  const persist = db.transaction(async (replyFiles) => {
    const msgId = await saveMessage(userId, conversationId, 'assistant', content, { memoryMeta, ...extra });
    const stmt = db.prepare('INSERT INTO files (id,conversation_id,message_id,kind,name,path,size,created_at) VALUES (?,?,?,?,?,?,?,?)');
    const cards = [];
    for (const file of replyFiles) {
      const id = nanoid();
      await stmt.run(id, conversationId, msgId, 'output', file.name, file.path, file.size, now());
      cards.push({ id, name: file.name, path: file.path, size: file.size });
    }
    return { msgId, cards };
  });
  return persist(Array.isArray(files) ? files : []);
}
