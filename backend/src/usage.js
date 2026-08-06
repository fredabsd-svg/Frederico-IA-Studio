// Helper centralizado para gravar em `usage`.
//
// Antes desta frente existiam 7 INSERTs espalhados por 6 arquivos, todos com a
// mesma string SQL e nenhum rótulo padronizado de feature. Para o painel admin
// agregar consumo por feature (chat, design, design-image, scheduled-task,
// multimodel) sem perder tempo reconciliando rótulos, centralizamos aqui.
//
// O custo (`cost_usd`) é calculado quando temos um perfil com preço conhecido
// (`pricingKnown`). Se não há perfil ou o preço é zero/desconhecido, gravamos
// NULL — o dashboard mostra volume separado de custo.
//
// Fail-safe: qualquer erro ao gravar em `usage` é logado mas NÃO propaga. A
// cobrança é secundária (auditoria); o request principal já foi processado.

import { nanoid } from 'nanoid';
import { db, now } from './db.js';

// Lista canônica de features. Se um caller passar algo fora dessa lista,
// gravamos mesmo assim (forward compat) mas logamos um aviso. Manter essa
// lista aqui facilita a checagem no painel admin.
export const KNOWN_FEATURES = ['chat', 'multimodel', 'design', 'design-image', 'scheduled-task'];

function estimateCost(promptTokens, completionTokens, profile) {
  if (!profile || !profile.pricingKnown) return null;
  const pt = Number(promptTokens || 0);
  const ct = Number(completionTokens || 0);
  const priceIn = Number(profile.price || 0);
  const priceOut = Number(profile.priceOut || 0);
  if (!Number.isFinite(priceIn) || !Number.isFinite(priceOut)) return null;
  // Sem float drift em casas altas: arredondar em 6 casas antes de gravar.
  const cost = pt * priceIn + ct * priceOut;
  return Number.isFinite(cost) ? Number(cost.toFixed(6)) : null;
}

// Grava uma linha em `usage`. Todos os campos são opcionais exceto o mínimo
// para identificar o request. Não levanta erro — falhas viram log.warn.
export async function recordUsage({
  userId,
  conversationId = null,
  assistantId = null,
  model,
  kind = 'chat',
  feature = null,
  tokens = null,
  promptTokens = 0,
  completionTokens = 0,
  profile = null,
}) {
  try {
    if (!userId) return; // sem userId não há o que agregar; ignora sem ruído

    const total = Number.isFinite(tokens)
      ? Number(tokens)
      : Number(promptTokens || 0) + Number(completionTokens || 0);

    const cost = estimateCost(promptTokens, completionTokens, profile);

    if (feature && !KNOWN_FEATURES.includes(feature)) {
      // Forward compat: gravamos mas avisamos (1x por label desconhecido).
      console.warn(`[usage] feature desconhecida: "${feature}" — gravando mesmo assim`);
    }

    await db.prepare(
      `INSERT INTO usage (id,user_id,conversation_id,assistant_id,model,kind,feature,prompt_tokens,completion_tokens,total_tokens,cost_usd,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      nanoid(),
      userId,
      conversationId,
      assistantId,
      model || null,
      kind,
      feature,
      Number(promptTokens || 0),
      Number(completionTokens || 0),
      total,
      cost,
      now(),
    );
  } catch (err) {
    console.warn('[usage] falha ao gravar (não-bloqueante):', err?.message || err);
  }
}