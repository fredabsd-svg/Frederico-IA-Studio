// Portão do modo gratuito para chamadas AVULSAS ao provedor — as que não
// passam pelo SSE do chat: Modo Design, Copiloto (chat, resumo, revisão, ações
// executivas). Quando o provedor resolvido é a chave da PLATAFORMA
// (`provider.source === 'free'`), valem os MESMOS portões do /chat:
//
//   1. limites (desligado → 429, bloqueado → 403, diário/por minuto → 429),
//      checados ANTES de qualquer chamada ao provedor;
//   2. vaga na fila global de concorrência (freeQueue.js);
//   3. contabilidade: toda chamada que chegou ao provedor CONTA no limite
//      diário (msgs + total_tokens), mesmo que a resposta venha inútil — o
//      consumo da chave da plataforma já ocorreu;
//   4. registro em free_tier_events (ok / limited / blocked / error).
//
// Antes, cada rota avulsa chamava o provedor gratuito direto: era um jeito de
// gastar a chave da casa sem teto, sem fila e sem registro.
import { enforceFreeTierLimits, bumpFreeTierUsage, logFreeTierEvent } from './freeTier.js';
import { acquireFreeSlot } from './freeQueue.js';

export const FREE_QUEUE_BUSY_MSG = 'O modo gratuito está com muitas solicitações agora. Aguarde alguns minutos e tente de novo — ou adicione a sua própria chave de API em Configurações.';

// Mesmo mapeamento do /chat: bloqueio por abuso é 403 (não adianta esperar);
// o resto (desligado, limite diário, freio por minuto, fila) é 429.
export function freeDenialStatus(code) {
  return code === 'free_blocked' ? 403 : 429;
}

// Corpo JSON de uma recusa, no formato que a interface já entende no /chat.
export function freeDenialBody(denial) {
  return {
    error: denial.error,
    code: denial.code,
    ...(denial.resetAt ? { resetAt: denial.resetAt } : {}),
    ...(denial.used != null ? { used: denial.used } : {}),
    ...(denial.limit != null ? { limit: denial.limit } : {}),
  };
}

// Abre o portão para UMA chamada. `label` identifica a origem no registro
// (ex.: 'design', 'copiloto:chat').
//
// Devolve `{ ok:false, status, code, error, ... }` (nada foi chamado) ou
// `{ ok:true, release, succeeded(completion), failed(err) }`. O chamador DEVE
// chamar `release()` num finally e exatamente um de `succeeded`/`failed`.
export async function openFreeTierGate({ userId, model, label }) {
  const denial = await enforceFreeTierLimits(userId);
  if (denial) {
    await logFreeTierEvent({ userId, model, status: denial.code === 'free_blocked' ? 'blocked' : 'limited', detail: `${label}:${denial.code}` });
    return { ok: false, status: freeDenialStatus(denial.code), ...freeDenialBody(denial) };
  }
  let release;
  try {
    release = await acquireFreeSlot({ id: `${label}:${userId}:${Date.now()}` });
  } catch (err) {
    await logFreeTierEvent({ userId, model, status: 'limited', detail: `${label}: fila cheia` });
    return { ok: false, status: 429, code: err?.code === 'FREE_QUEUE_FULL' ? 'free_queue_full' : 'free_queue', error: FREE_QUEUE_BUSY_MSG };
  }
  let settled = false;
  return {
    ok: true,
    release,
    async succeeded(completion) {
      if (settled) return;
      settled = true;
      const tokens = completion?.usage?.total_tokens || 0;
      await bumpFreeTierUsage(userId, tokens);
      await logFreeTierEvent({ userId, model: completion?.model || model, status: 'ok', detail: label, tokens });
    },
    async failed(err) {
      if (settled) return;
      settled = true;
      await logFreeTierEvent({ userId, model, status: 'error', detail: `${label}: ${String(err?.message || err).slice(0, 200)}` });
    },
  };
}
