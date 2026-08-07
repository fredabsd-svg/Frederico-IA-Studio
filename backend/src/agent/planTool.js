// Plano de tarefas ESTRUTURADO do Modo Desenvolvedor (Fase 8 do Developer
// Workspace 3.0).
//
// `update_plan` é uma ferramenta INTERNA, interceptada antes do runTool (como o
// ask_user): não roda no sandbox, não toca arquivo nem rede. O modelo mantém a
// lista de passos da missão; cada chamada substitui o plano inteiro (semântica
// simples e idempotente — replay não corrompe). O evento `plan_update` vai ao
// stream e ao run log durável, então o plano sobrevive a reload e restart, e o
// estado final entra no `execution_meta` da mensagem.
//
// Regra de honestidade (a mesma do restante do app): um passo só pode ficar
// `completed` com EVIDÊNCIA verificável — o comando executado, o arquivo
// alterado, o teste que passou. Sem evidência a atualização é recusada e o
// modelo corrige na etapa seguinte.

export const UPDATE_PLAN_TOOL_NAME = 'update_plan';

export const PLAN_STEP_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'skipped']);

const MAX_STEPS = 30;
const MAX_TITLE = 200;
const MAX_EVIDENCE = 400;

export const updatePlanToolDefinition = {
  type: 'function',
  function: {
    name: UPDATE_PLAN_TOOL_NAME,
    description: 'Mantém o plano visível da tarefa (Modo Desenvolvedor). Chame ao começar uma missão com 2+ etapas e a cada mudança de status. Cada chamada SUBSTITUI o plano inteiro — envie sempre a lista completa. Um passo só pode ser "completed" com evidence preenchida (comando executado, arquivo alterado, teste que passou).',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: `Lista completa e ordenada dos passos (máx. ${MAX_STEPS}).`,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Identificador estável do passo (ex.: "1", "mapear-fluxo"). Reuse o mesmo id entre atualizações.' },
              title: { type: 'string', description: 'O passo, curto e verificável.' },
              status: { type: 'string', enum: [...PLAN_STEP_STATUSES] },
              evidence: { type: 'string', description: 'OBRIGATÓRIO quando status=completed: a prova (comando + resultado, arquivo, teste).' }
            },
            required: ['title', 'status']
          }
        }
      },
      required: ['steps']
    }
  }
};

// Nota de sistema que entra quando a ferramenta está na mesa.
export const PLAN_TOOL_NOTE = 'PLANO VISÍVEL: para missões com 2+ etapas, mantenha o plano com a ferramenta update_plan — crie no início (passos curtos e verificáveis) e atualize o status a cada avanço (running → completed com a evidência, ou failed/skipped com o motivo no título). O usuário acompanha esse plano na interface; ele NÃO substitui a sua resposta final. Para pedidos triviais de um passo, não crie plano.';

// A ferramenta só faz sentido onde há missão de desenvolvimento: modo
// desenvolvedor, com ferramentas na mesa, fora de sub-agente (o plano é da
// tarefa do PAI) e fora de turno social.
export function shouldOfferUpdatePlan({ developerContext = null, isSubagent = false, lowSignalTurn = false, hasTools = false } = {}) {
  return Boolean(developerContext && hasTools && !isSubagent && !lowSignalTurn);
}

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Valida/normaliza uma chamada de update_plan. Devolve { plan } ou { error }
// (o erro volta ao MODELO como resultado de ferramenta — nunca à conversa).
export function normalizePlanUpdate(args) {
  const steps = args?.steps;
  if (!Array.isArray(steps) || !steps.length) {
    return { error: 'Envie "steps" com a lista completa de passos do plano.' };
  }
  if (steps.length > MAX_STEPS) {
    return { error: `O plano aceita no máximo ${MAX_STEPS} passos — consolide etapas.` };
  }
  const normalized = [];
  const seenIds = new Set();
  for (let index = 0; index < steps.length; index++) {
    const raw = steps[index] || {};
    const title = clip(raw.title, MAX_TITLE);
    if (!title) return { error: `O passo ${index + 1} está sem título.` };
    const status = String(raw.status || '').trim();
    if (!PLAN_STEP_STATUSES.includes(status)) {
      return { error: `Status inválido no passo ${index + 1} ("${raw.status}"). Use: ${PLAN_STEP_STATUSES.join(', ')}.` };
    }
    const evidence = clip(raw.evidence, MAX_EVIDENCE);
    if (status === 'completed' && !evidence) {
      return { error: `O passo ${index + 1} ("${title}") está "completed" sem evidência. Informe em "evidence" a prova verificável (comando executado e resultado, arquivo alterado, teste que passou) — ou mantenha o passo como running.` };
    }
    let id = clip(raw.id, 60) || String(index + 1);
    while (seenIds.has(id)) id = `${id}_${index + 1}`;
    seenIds.add(id);
    normalized.push({ id, title, status, ...(evidence ? { evidence } : {}) });
  }
  return { plan: { steps: normalized, updatedAt: new Date().toISOString() } };
}
