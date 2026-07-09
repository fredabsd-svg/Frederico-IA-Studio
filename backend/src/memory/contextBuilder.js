import { db } from '../db.js';
import { getSettings, searchMemories, searchChunks } from './memoryService.js';
import { estimateTokens } from './indexer.js';

// Context Builder: monta o contexto inteligente antes de cada resposta.
// Ordem de prioridade (o que menos importa é cortado primeiro se faltar espaço):
//   1. Perfil e preferências do usuário (+ memórias fixadas)
//   2. Memórias manuais dos escopos aplicáveis (global/cliente/assistente)
//   3. Resumo do início da conversa atual (quando ela é longa)
//   4. Memórias relevantes recuperadas por busca semântica
//   5. Trechos de conversas antigas/importadas relevantes
// O total respeita context_target_tokens (configurável — suba para modelos 1M).

const TYPE_LABEL = { perfil: 'Perfil', preferencia: 'Preferência', projeto: 'Projeto', fato: 'Fato', manual: 'Nota' };

function fmtMem(m) {
  const when = (m.updated_at || m.created_at || '').slice(0, 10);
  return `- [${TYPE_LABEL[m.type] || m.type}${m.pinned ? ' 📌' : ''}] ${m.content}${when ? ` (${when})` : ''}`;
}

export async function buildContext({ conversationId, assistantId, clientScope, userText, historyLimit = 60 }) {
  const s = getSettings();
  if (!s.memory_enabled) return [];

  const scopes = ['global'];
  if (assistantId) scopes.push(assistantId);
  if (clientScope) scopes.push(clientScope);
  const ph = scopes.map(() => '?').join(',');

  const blocks = []; // { priority, text }

  // 1) Perfil, preferências e fixadas — sempre presentes
  const profile = db.prepare(
    `SELECT * FROM memory WHERE scope IN (${ph}) AND (type IN ('perfil','preferencia') OR pinned=1)
     ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 14`).all(...scopes);
  if (profile.length) {
    blocks.push({ priority: 1, text: `QUEM É O USUÁRIO (memória de longo prazo — use quando relevante, ex.: "quem sou eu?"):\n${profile.map(fmtMem).join('\n')}` });
  }

  // 2) Memórias manuais dos escopos aplicáveis (comportamento clássico)
  const profileIds = new Set(profile.map(p => p.id));
  const manual = db.prepare(
    `SELECT * FROM memory WHERE scope IN (${ph}) AND type='manual' ORDER BY updated_at DESC LIMIT 15`).all(...scopes)
    .filter(m => !profileIds.has(m.id));
  if (manual.length) {
    blocks.push({ priority: 2, text: `NOTAS SALVAS PELO USUÁRIO:\n${manual.map(fmtMem).join('\n')}` });
  }

  // 3) Resumo do início da conversa atual (o que saiu da janela de mensagens)
  const conv = db.prepare('SELECT summary_long, summary_short FROM conversations WHERE id=?').get(conversationId);
  const msgCount = db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id=?').get(conversationId)?.c || 0;
  if (msgCount > historyLimit && (conv?.summary_long || conv?.summary_short)) {
    blocks.push({ priority: 3, text: `RESUMO DO INÍCIO DESTA CONVERSA (mensagens antigas fora da janela):\n${conv.summary_long || conv.summary_short}` });
  }

  // 4) Memórias relevantes à pergunta (busca semântica com ranking)
  const seen = new Set([...profileIds, ...manual.map(m => m.id)]);
  try {
    const rel = (await searchMemories(userText, { scopes, limit: s.max_memories })).filter(m => !seen.has(m.id));
    if (rel.length) blocks.push({ priority: 4, text: `MEMÓRIAS RELEVANTES PARA ESTA PERGUNTA:\n${rel.map(fmtMem).join('\n')}` });
  } catch {}

  // 5) Trechos de conversas antigas/importadas parecidos com a pergunta
  try {
    const chunks = await searchChunks(userText, { excludeConversationId: conversationId, scopes: clientScope ? ['global', clientScope] : ['global'], limit: s.max_chunks });
    if (chunks.length) {
      const txt = chunks.map(c => `--- ${c.source_title || 'Conversa anterior'} (${(c.created_at || '').slice(0, 10)}) ---\n${c.content}`).join('\n');
      blocks.push({ priority: 5, text: `TRECHOS DE CONVERSAS ANTERIORES RELEVANTES (contexto recuperado automaticamente):\n${txt}` });
    }
  } catch {}

  // Orçamento de tokens: corta dos menos importantes para os mais importantes
  const budget = Math.max(4000, Number(s.context_target_tokens) || 60000);
  const ordered = blocks.sort((a, b) => a.priority - b.priority);
  const kept = [];
  let used = 0;
  for (const b of ordered) {
    const t = estimateTokens(b.text);
    if (used + t > budget) {
      const remaining = budget - used;
      if (remaining > 800) { kept.push(b.text.slice(0, Math.floor(remaining * 3.5))); used = budget; }
      break;
    }
    kept.push(b.text);
    used += t;
  }
  return kept;
}
