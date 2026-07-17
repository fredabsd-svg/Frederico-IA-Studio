import { db } from '../db.js';
import { getSettings, searchMemories, searchChunks, ECONOMY_CONTEXT_TOKENS } from './memoryService.js';
import { estimateTokens } from './indexer.js';
import { isLowSignalTurn } from './retrievalPolicy.js';

// Context Builder 2.0
// Monta um contexto seguro por modelo e tambem devolve metadados para a UI
// mostrar ao usuario quais memorias/trechos foram usados.

const TYPE_LABEL = {
  perfil: 'Perfil',
  preferencia: 'Preferencia',
  projeto: 'Projeto',
  fato: 'Fato',
  manual: 'Nota'
};

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function modelContextCap(model) {
  const id = String(model || '').toLowerCase();
  if (/(mini|flash|haiku|8b|7b|3b|free|small)/.test(id)) return { cap: 18000, tier: 'leve' };
  if (/(1m|1000k|1024k|200k|256k|128k|gemini-1\.5|gemini-2|claude|sonnet|opus)/.test(id)) return { cap: 120000, tier: 'grande' };
  if (/(gpt-4|deepseek|qwen|llama|mistral|command)/.test(id)) return { cap: 60000, tier: 'medio' };
  return { cap: 32000, tier: 'padrao' };
}

export function contextBudgetForModel(model, settings = getSettings()) {
  let configured = Math.max(4000, Number(settings.context_target_tokens) || 60000);
  // Economia de tokens: limita o contexto injetado por mensagem (isso também
  // reduz memórias, trechos e histórico, que escalam com o orçamento).
  if (settings.economy_mode) configured = Math.min(configured, ECONOMY_CONTEXT_TOKENS);
  const { cap } = modelContextCap(model);
  return Math.max(4000, Math.min(configured, cap));
}

export function historyBudgetForModel(model, contextBudget) {
  const { tier } = modelContextCap(model);
  const ratio = tier === 'leve' ? 0.45 : tier === 'grande' ? 0.65 : 0.55;
  return Math.max(5000, Math.min(70000, Math.floor((contextBudget || 32000) * ratio)));
}

function trimForTokens(text, maxTokens) {
  const raw = String(text || '');
  const maxChars = Math.max(200, Math.floor(maxTokens * 3.5));
  if (raw.length <= maxChars) return raw;
  return raw.slice(0, maxChars - 80) + '\n\n[conteudo encurtado automaticamente para caber na janela de contexto]';
}

export async function selectHistoryForContext({ conversationId, limit = 60, budgetTokens = 25000 } = {}) {
  const rowsDesc = await db.prepare(`
    SELECT role, content, created_at FROM messages
    WHERE conversation_id=? ORDER BY created_at DESC, seq DESC LIMIT ?
  `).all(conversationId, limit);
  const kept = [];
  let usedTokens = 0;
  let clipped = false;

  for (const row of rowsDesc) {
    const tokens = estimateTokens(row.content);
    if (!kept.length && tokens > budgetTokens) {
      kept.push({ ...row, content: trimForTokens(row.content, budgetTokens) });
      usedTokens = budgetTokens;
      clipped = true;
      continue;
    }
    if (usedTokens + tokens <= budgetTokens) {
      kept.push(row);
      usedTokens += tokens;
    } else {
      clipped = true;
    }
  }

  return {
    rows: kept.reverse(),
    meta: {
      budget: budgetTokens,
      usedTokens,
      included: kept.length,
      available: rowsDesc.length,
      clipped
    }
  };
}

function fmtMem(m) {
  const when = (m.updated_at || m.created_at || '').slice(0, 10);
  return `- [${TYPE_LABEL[m.type] || m.type}${m.pinned ? ' FIXADA' : ''}] ${m.content}${when ? ` (${when})` : ''}`;
}

function scopeLabel(scope) {
  if (scope === 'global') return 'Voce';
  if (scope === 'office') return 'Escritorio';
  if (scope?.startsWith('client:')) return 'Cliente';
  return 'Assistente';
}

function memoryMeta(m, reason) {
  return {
    id: m.id,
    type: m.type,
    scope: m.scope,
    scopeLabel: scopeLabel(m.scope),
    pinned: !!m.pinned,
    source: m.source_type || 'manual',
    reason,
    preview: String(m.content || '').slice(0, 180)
  };
}

function chunkMeta(c) {
  return {
    title: c.source_title || 'Conversa anterior',
    scope: c.scope || 'global',
    scopeLabel: scopeLabel(c.scope || 'global'),
    date: (c.created_at || '').slice(0, 10),
    preview: String(c.content || '').replace(/\s+/g, ' ').slice(0, 220)
  };
}

function addBlockMeta(meta, block) {
  for (const m of block.memories || []) {
    if (!meta._memoryIds.has(m.id)) {
      meta._memoryIds.add(m.id);
      meta.memories.push(m);
    }
  }
  for (const c of block.chunks || []) meta.chunks.push(c);
  if (block.summary) meta.summaries += 1;
}

function publicMeta(meta) {
  const { _memoryIds, ...clean } = meta;
  clean.stats = {
    memoriesUsed: clean.memories.length,
    chunksUsed: clean.chunks.length,
    summariesUsed: clean.summaries,
    contextTokens: clean.usedTokens,
    contextBudget: clean.budget
  };
  return clean;
}

export async function buildContext({ conversationId, assistantId, clientScope, userText, historyLimit = 60, model = null }) {
  const settings = getSettings();
  const capInfo = modelContextCap(model);
  const budget = contextBudgetForModel(model, settings);
  const meta = {
    enabled: !!settings.memory_enabled,
    model: model || null,
    modelTier: capInfo.tier,
    configuredTarget: Math.max(4000, Number(settings.context_target_tokens) || 60000),
    modelCap: capInfo.cap,
    budget,
    usedTokens: 0,
    blockCount: 0,
    truncated: false,
    omittedBlocks: 0,
    retrievalSkipped: null,
    scopes: [],
    memories: [],
    chunks: [],
    summaries: 0,
    _memoryIds: new Set()
  };

  if (!settings.memory_enabled) return { blocks: [], meta: publicMeta(meta) };

  // Saudações e confirmações curtas não carregam sinal semântico suficiente.
  // O histórico da conversa atual é anexado separadamente pelo agente.
  if (isLowSignalTurn(userText)) {
    meta.retrievalSkipped = 'low_signal';
    return { blocks: [], meta: publicMeta(meta) };
  }

  const scopes = unique(['global', 'office', assistantId, clientScope]);
  meta.scopes = scopes.map(scope => ({ scope, label: scopeLabel(scope) }));
  const ph = scopes.map(() => '?').join(',');
  const blocks = [];

  // 1) Perfil, preferencias e fixadas: prioridade maxima.
  const profile = await db.prepare(
    `SELECT * FROM memory WHERE scope IN (${ph}) AND (type IN ('perfil','preferencia') OR pinned=1)
     ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 14`).all(...scopes);
  if (profile.length) {
    blocks.push({
      priority: 1,
      text: `QUEM E O USUARIO (memoria de longo prazo; use quando relevante):\n${profile.map(fmtMem).join('\n')}`,
      memories: profile.map(m => memoryMeta(m, 'perfil/preferencia/fixada'))
    });
  }

  // 2) Notas manuais dos escopos aplicaveis.
  const profileIds = new Set(profile.map(p => p.id));
  const manual = (await db.prepare(
    `SELECT * FROM memory WHERE scope IN (${ph}) AND type='manual' ORDER BY updated_at DESC LIMIT 15`).all(...scopes))
    .filter(m => !profileIds.has(m.id));
  if (manual.length) {
    blocks.push({
      priority: 2,
      text: `NOTAS SALVAS PELO USUARIO:\n${manual.map(fmtMem).join('\n')}`,
      memories: manual.map(m => memoryMeta(m, 'nota manual'))
    });
  }

  // 3) Resumo da conversa atual quando o inicio saiu da janela.
  const conv = await db.prepare('SELECT summary_long, summary_short FROM conversations WHERE id=?').get(conversationId);
  const msgCount = Number((await db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id=?').get(conversationId))?.c || 0);
  if (msgCount > historyLimit && (conv?.summary_long || conv?.summary_short)) {
    blocks.push({
      priority: 3,
      text: `RESUMO DO INICIO DESTA CONVERSA (mensagens antigas fora da janela):\n${conv.summary_long || conv.summary_short}`,
      summary: true
    });
  }

  // 4) Memorias relevantes para a pergunta.
  const seen = new Set([...profileIds, ...manual.map(m => m.id)]);
  try {
    const limit = Math.max(0, Math.min(Number(settings.max_memories) || 0, budget < 20000 ? 6 : 16));
    const rel = limit ? (await searchMemories(userText, { scopes, limit })).filter(m => !seen.has(m.id)) : [];
    if (rel.length) {
      blocks.push({
        priority: 4,
        text: `MEMORIAS RELEVANTES PARA ESTA PERGUNTA:\n${rel.map(fmtMem).join('\n')}`,
        memories: rel.map(m => memoryMeta(m, 'busca semantica'))
      });
    }
  } catch {}

  // 5) Trechos de conversas antigas/importadas, com isolamento por cliente.
  try {
    const chunkScopes = clientScope ? unique(['office', clientScope]) : unique(['global', 'office']);
    const limit = Math.max(0, Math.min(Number(settings.max_chunks) || 0, budget < 20000 ? 3 : 12));
    const chunks = limit ? await searchChunks(userText, { excludeConversationId: conversationId, scopes: chunkScopes, limit }) : [];
    if (chunks.length) {
      const txt = chunks.map(c => `--- ${c.source_title || 'Conversa anterior'} (${(c.created_at || '').slice(0, 10)}) ---\n${c.content}`).join('\n');
      blocks.push({
        priority: 5,
        text: `TRECHOS DE CONVERSAS ANTERIORES RELEVANTES (contexto recuperado automaticamente):\n${txt}`,
        chunks: chunks.map(chunkMeta)
      });
    }
  } catch {}

  // Orcamento: corta primeiro o menos importante. Nunca deixa o alvo configurado
  // passar do teto automatico do modelo.
  const ordered = blocks.sort((a, b) => a.priority - b.priority);
  const kept = [];
  let used = 0;
  for (const b of ordered) {
    const t = estimateTokens(b.text);
    if (used + t > budget) {
      const remaining = budget - used;
      // Bloco não cabe inteiro. Se ainda houver folga razoável, encaixa uma
      // versão aparada dele; senão, pula ESTE bloco e segue tentando os
      // próximos (menores) em vez de abandonar todos de uma vez.
      if (remaining > 800 && !meta.truncated) {
        kept.push(trimForTokens(b.text, remaining));
        used = budget;
        meta.truncated = true;
        addBlockMeta(meta, b);
      } else {
        meta.omittedBlocks += 1;
      }
      continue;
    }
    kept.push(b.text);
    used += t;
    addBlockMeta(meta, b);
  }
  meta.usedTokens = used;
  meta.blockCount = kept.length;
  return { blocks: kept, meta: publicMeta(meta) };
}
