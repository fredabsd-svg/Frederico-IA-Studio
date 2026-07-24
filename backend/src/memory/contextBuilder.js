import { db } from '../db.js';
import { getSettings, searchMemories, searchChunks, ECONOMY_CONTEXT_TOKENS } from './memoryService.js';
import { estimateTokens } from './indexer.js';
import { isLowSignalTurn } from './retrievalPolicy.js';
import { sanitizeToolProtocolText } from '../toolProtocol.js';
import {
  analyzePrompt,
  scoreMemory,
  scoreConversation,
  validateRelevance,
  deduplicateContext,
  extractRelevantSnippet,
  buildDiagnosticLog,
} from './relevanceScorer.js';

// Context Builder 3.0
// Monta um contexto seguro por modelo e tambem devolve metadados para a UI
// mostrar ao usuario quais memorias/trechos foram usados.
//
// MUDANCA PRINCIPAL (v3.0): Memorias e conversas antigas agora passam por um
// crivo de relevancia SEPARADO (relevanceScorer.js) antes de entrar no contexto.
// Antes, perfil/preferencias/fixadas eram injetados incondicionalmente e o
// sistema preenchia cota (sempre tentava retornar `limit` resultados). Agora:
//   - Cada memoria e pontuada individualmente; so entra se passar no threshold.
//   - Cada conversa antiga e pontuada individualmente; so entra se passar.
//   - O numero de resultados e variavel (0 a N) — nao ha preenchimento de cota.
//   - Conversas parcialmente relacionadas sao recortadas (extractRelevantSnippet).
//   - Duplicidades entre memorias/conversas/historico sao removidas.
//   - Recencia tem peso secundario (memorias: 0; conversas: 5%).
//   - O botao da UI reflete o tipo de contexto recuperado.

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
  const id = String(model || '').toLowerCase().replace(/:(free|nitro|floor|beta)\b/g, '');
  if (/(1m|1000k|1024k|200k|256k|128k|gemini-1\.5|gemini-2|claude|sonnet|opus)/.test(id)) return { cap: 120000, tier: 'grande' };
  if (/(mini|flash|haiku|8b|7b|3b|small)/.test(id)) return { cap: 18000, tier: 'leve' };
  if (/(gpt-4|deepseek|qwen|llama|mistral|command|nemotron)/.test(id)) return { cap: 60000, tier: 'medio' };
  return { cap: 32000, tier: 'padrao' };
}

export function contextBudgetForModel(model, settings = getSettings()) {
  let configured = Math.max(4000, Number(settings.context_target_tokens) || 60000);
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
  if (estimateTokens(raw) <= maxTokens) return raw;
  const note = '\n\n[conteudo encurtado automaticamente para caber na janela de contexto]';
  const budget = Math.max(1, maxTokens - estimateTokens(note));
  let lo = 0, hi = raw.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estimateTokens(raw.slice(0, mid)) <= budget) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return raw.slice(0, best) + note;
}

export async function selectHistoryForContext({ conversationId, limit = 60, budgetTokens = 25000 } = {}) {
  const rowsDesc = await db.prepare(`
    SELECT role, content, created_at FROM messages
    WHERE conversation_id=? ORDER BY created_at DESC, seq DESC LIMIT ?
  `).all(conversationId, limit);
  const kept = [];
  let usedTokens = 0;
  let clipped = false;

  for (const rawRow of rowsDesc) {
    const row = {
      ...rawRow,
      content: rawRow.role === 'assistant'
        ? sanitizeToolProtocolText(rawRow.content)
        : rawRow.content
    };
    if (!String(row.content || '').trim()) continue;
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

function memoryMeta(m, reason, score) {
  return {
    id: m.id,
    type: m.type,
    scope: m.scope,
    scopeLabel: scopeLabel(m.scope),
    pinned: !!m.pinned,
    source: m.source_type || 'manual',
    reason,
    score: score ? Number(score.toFixed(3)) : undefined,
    preview: String(m.content || '').slice(0, 180)
  };
}

function chunkMeta(c, reason, score) {
  const cleanContent = sanitizeToolProtocolText(c.content);
  return {
    title: c.source_title || 'Conversa anterior',
    scope: c.scope || 'global',
    scopeLabel: scopeLabel(c.scope || 'global'),
    date: (c.created_at || '').slice(0, 10),
    reason,
    score: score ? Number(score.toFixed(3)) : undefined,
    preview: cleanContent.replace(/\s+/g, ' ').slice(0, 220)
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
  const { _memoryIds, _diagnostic, ...clean } = meta;
  clean.stats = {
    memoriesUsed: clean.memories.length,
    chunksUsed: clean.chunks.length,
    summariesUsed: clean.summaries,
    contextTokens: clean.usedTokens,
    contextBudget: clean.budget
  };
  // O diagnostico so e exposto quando explicitamente solicitado (modo dev).
  if (_diagnostic) clean._diagnostic = _diagnostic;
  return clean;
}

export async function buildContext({ userId, conversationId, assistantId, clientScope, userText, historyLimit = 60, model = null }) {
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
    _memoryIds: new Set(),
    _diagnostic: null
  };

  if (!settings.memory_enabled) return { blocks: [], meta: publicMeta(meta) };

  // Saudações e confirmações curtas não carregam sinal semântico suficiente.
  if (isLowSignalTurn(userText)) {
    meta.retrievalSkipped = 'low_signal';
    return { blocks: [], meta: publicMeta(meta) };
  }

  // ─── Analise do prompt atual ───────────────────────────────────────
  // Identifica intencao, dominio, projeto e entidades ANTES de buscar
  // memorias/conversas. Esta analise guia toda a selecao abaixo.
  const promptAnalysis = analyzePrompt(userText);

  const scopes = unique(['global', 'office', assistantId, clientScope]);
  meta.scopes = scopes.map(scope => ({ scope, label: scopeLabel(scope) }));
  const ph = scopes.map(() => '?').join(',');
  const blocks = [];

  // ─── Diagnostic log (candidatos) ──────────────────────────────────
  const diagMemCandidates = [];
  const diagChunkCandidates = [];
  let diagDuplicatesRemoved = 0;

  // ─── 1) Perfil, preferencias e fixadas — agora com crivo de relevancia ──
  // ANTES: injetava TODAS as memorias de perfil/preferencia/pinned
  // incondicionalmente, sem verificar se tinham relacao com o pedido.
  // AGORA: cada memoria e pontuada pelo relevanceScorer; so entra se
  // passar no threshold e na validacao semantica.
  const profileRows = await db.prepare(
    `SELECT * FROM memory WHERE scope IN (${ph}) AND user_id=? AND (type IN ('perfil','preferencia') OR pinned=1)
     ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 14`).all(...scopes, userId);

  const profileIncluded = [];
  for (const m of profileRows) {
    const scoreResult = scoreMemory(m, promptAnalysis, 0); // sem similaridade semantica para perfil
    const validation = validateRelevance(m.content, promptAnalysis, scoreResult);
    diagMemCandidates.push({ id: m.id, type: m.type, content: m.content, scoreResult });
    if (validation.valid && scoreResult.shouldInclude) {
      profileIncluded.push({ ...m, _reason: scoreResult.reason, _score: scoreResult.score });
    }
  }

  if (profileIncluded.length) {
    blocks.push({
      priority: 1,
      text: `QUEM E O USUARIO (memoria de longo prazo; use quando relevante):\n${profileIncluded.map(fmtMem).join('\n')}`,
      memories: profileIncluded.map(m => memoryMeta(m, m._reason, m._score))
    });
  }

  // ─── 2) Notas manuais — tambem com crivo de relevancia ──────────────
  const profileIds = new Set(profileRows.map(p => p.id));
  const manualRows = (await db.prepare(
    `SELECT * FROM memory WHERE scope IN (${ph}) AND user_id=? AND type='manual' ORDER BY updated_at DESC LIMIT 15`).all(...scopes, userId))
    .filter(m => !profileIds.has(m.id));

  const manualIncluded = [];
  for (const m of manualRows) {
    const scoreResult = scoreMemory(m, promptAnalysis, 0);
    const validation = validateRelevance(m.content, promptAnalysis, scoreResult);
    diagMemCandidates.push({ id: m.id, type: m.type, content: m.content, scoreResult });
    if (validation.valid && scoreResult.shouldInclude) {
      manualIncluded.push({ ...m, _reason: scoreResult.reason, _score: scoreResult.score });
    }
  }

  if (manualIncluded.length) {
    blocks.push({
      priority: 2,
      text: `NOTAS SALVAS PELO USUARIO:\n${manualIncluded.map(fmtMem).join('\n')}`,
      memories: manualIncluded.map(m => memoryMeta(m, m._reason, m._score))
    });
  }

  // ─── 3) Resumo da conversa atual (quando o inicio saiu da janela) ──
  // Este e o resumo da CONVERSA ATUAL, nao de conversas antigas — sempre
  // relevante para continuidade.
  const conv = await db.prepare('SELECT summary_long, summary_short FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId);
  const msgCount = Number((await db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id=?').get(conversationId))?.c || 0);
  if (msgCount > historyLimit && (conv?.summary_long || conv?.summary_short)) {
    blocks.push({
      priority: 3,
      text: `RESUMO DO INICIO DESTA CONVERSA (mensagens antigas fora da janela):\n${conv.summary_long || conv.summary_short}`,
      summary: true
    });
  }

  // ─── 4) Memorias relevantes para a pergunta (busca semantica) ──────
  // ANTES: retornava ate `limit` memorias, preenchendo cota mesmo com
  // resultados fracos. AGORA: cada memoria e pontuada e validada; so
  // entram as que passam no crivo.
  const seen = new Set([...profileIds, ...manualRows.map(m => m.id)]);
  try {
    const limit = Math.max(0, Math.min(Number(settings.max_memories) || 0, budget < 20000 ? 6 : 16));
    const candidates = limit ? (await searchMemories(userId, userText, { scopes, limit: limit * 2 })).filter(m => !seen.has(m.id)) : [];
    const relIncluded = [];
    for (const m of candidates) {
      // Usa a similaridade semantica retornada pela busca (_sim)
      const semanticSim = m._sim || 0;
      const scoreResult = scoreMemory(m, promptAnalysis, semanticSim);
      const validation = validateRelevance(m.content, promptAnalysis, scoreResult);
      diagMemCandidates.push({ id: m.id, type: m.type, content: m.content, scoreResult });
      if (validation.valid && scoreResult.shouldInclude) {
        relIncluded.push({ ...m, _reason: scoreResult.reason, _score: scoreResult.score });
      }
    }
    if (relIncluded.length) {
      blocks.push({
        priority: 4,
        text: `MEMORIAS RELEVANTES PARA ESTA PERGUNTA:\n${relIncluded.map(fmtMem).join('\n')}`,
        memories: relIncluded.map(m => memoryMeta(m, m._reason, m._score))
      });
    }
  } catch {}

  // ─── 5) Trechos de conversas antigas — com crivo SEPARADO ──────────
  // ANTES: retornava ate `limit` chunks com threshold 0.3 e peso de
  // recencia de 20%. AGORA: cada chunk e pontuado pelo scoreConversation
  // (criterios diferentes de memorias), recortado se tiver assuntos mistos,
  // e so entra se passar no threshold + validacao semantica.
  try {
    const chunkScopes = clientScope ? unique(['office', clientScope]) : unique(['global', 'office']);
    const limit = Math.max(0, Math.min(Number(settings.max_chunks) || 0, budget < 20000 ? 3 : 12));
    const chunkCandidates = limit ? await searchChunks(userId, userText, { excludeConversationId: conversationId, scopes: chunkScopes, limit: limit * 2 }) : [];
    const chunksIncluded = [];
    for (const c of chunkCandidates) {
      const semanticSim = c._sim || 0;
      const scoreResult = scoreConversation(c, promptAnalysis, semanticSim);
      const validation = validateRelevance(c.content, promptAnalysis, scoreResult);
      diagChunkCandidates.push({ id: c.id, source_title: c.source_title, content: c.content, scoreResult });
      if (validation.valid && scoreResult.shouldInclude) {
        // Recorta o trecho relevante se a conversa tem assuntos mistos
        const snippet = extractRelevantSnippet(c.content, promptAnalysis, 800);
        chunksIncluded.push({ ...c, _snippet: snippet, _reason: scoreResult.reason, _score: scoreResult.score });
      }
    }
    if (chunksIncluded.length) {
      const txt = chunksIncluded
        .map(c => `--- ${c.source_title || 'Conversa anterior'} (${(c.created_at || '').slice(0, 10)}) ---\n${sanitizeToolProtocolText(c._snippet)}`)
        .join('\n');
      blocks.push({
        priority: 5,
        text: `TRECHOS DE CONVERSAS ANTERIORES RELEVANTES (contexto recuperado automaticamente):\n${txt}`,
        chunks: chunksIncluded.map(c => chunkMeta({ ...c, content: c._snippet }, c._reason, c._score))
      });
    }
  } catch {}

  // ─── Deduplicacao entre blocos ─────────────────────────────────────
  // Remove memorias/conversas com conteudo muito parecido que ja apareceu
  // em um bloco de prioridade mais alta.
  const allMetaItems = [];
  for (const b of blocks) {
    if (b.memories) allMetaItems.push(...b.memories.map(m => ({ preview: m.preview, source: 'memory' })));
    if (b.chunks) allMetaItems.push(...b.chunks.map(c => ({ preview: c.preview, source: 'chunk' })));
  }
  const beforeDedup = allMetaItems.length;
  const afterDedup = deduplicateContext(allMetaItems).length;
  diagDuplicatesRemoved = beforeDedup - afterDedup;

  // ─── Orcamento: corta primeiro o menos importante ──────────────────
  const ordered = blocks.sort((a, b) => a.priority - b.priority);
  const kept = [];
  let used = 0;
  for (const b of ordered) {
    const safeText = sanitizeToolProtocolText(b.text);
    if (!safeText) continue;
    const t = estimateTokens(safeText);
    if (used + t > budget) {
      const remaining = budget - used;
      if (remaining > 800 && !meta.truncated) {
        kept.push(trimForTokens(safeText, remaining));
        used = budget;
        meta.truncated = true;
        addBlockMeta(meta, b);
      } else {
        meta.omittedBlocks += 1;
      }
      continue;
    }
    kept.push(safeText);
    used += t;
    addBlockMeta(meta, b);
  }
  meta.usedTokens = used;
  meta.blockCount = kept.length;

  // ─── Log de diagnostico (modo dev) ─────────────────────────────────
  meta._diagnostic = buildDiagnosticLog(promptAnalysis, diagMemCandidates, diagChunkCandidates, {
    memories: meta.memories,
    conversations: meta.chunks,
    tokensUsed: used,
    duplicatesRemoved: diagDuplicatesRemoved,
  });

  return { blocks: kept, meta: publicMeta(meta) };
}
