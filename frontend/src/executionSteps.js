// Agrupamento das etapas do Ambiente de Trabalho da IA.
//
// Quando o agente delega uma subtarefa (`delegar_subagente`), as ferramentas
// executadas pelo SUB-AGENTE chegam ao stream como etapas próprias, marcadas
// com `parentId` (o id da delegação) e `subagent` (o nome de quem executou).
// Aqui elas são recolhidas para DENTRO da delegação, em vez de aparecerem
// soltas no meio das etapas do agente principal.
//
// Isso importa porque as delegações do mesmo lote correm EM PARALELO: no array
// achatado, as etapas de dois sub-agentes chegam intercaladas, na ordem em que
// cada um terminou. Sem o agrupamento, a lista viraria uma salada de ações de
// donos diferentes.

export const SUBAGENT_TOOL = 'delegar_subagente';

// Devolve [{ s, i, depth }] na ordem de exibição: cada etapa do agente
// principal seguida das etapas dos sub-agentes que ela disparou (depth 1).
// `i` é o índice ORIGINAL no array de etapas — a seleção do painel de detalhe
// continua apontando para a etapa certa.
export function groupExecutionSteps(steps = []) {
  const known = new Set(steps.map(step => step?.id).filter(Boolean));
  const children = new Map();
  steps.forEach((step, i) => {
    if (!step?.parentId || !known.has(step.parentId)) return;
    if (!children.has(step.parentId)) children.set(step.parentId, []);
    children.get(step.parentId).push({ s: step, i, depth: 1 });
  });

  const rows = [];
  steps.forEach((step, i) => {
    // Já será exibida dentro da delegação que a originou.
    if (step?.parentId && known.has(step.parentId)) return;
    // Etapa órfã (delegação fora deste lote de blocos, ou stream parcial): fica
    // no lugar dela, recuada — sumir da lista seria pior que aparecer solta.
    rows.push({ s: step, i, depth: step?.parentId ? 1 : 0 });
    if (step?.id && children.has(step.id)) rows.push(...children.get(step.id));
  });
  return rows;
}

// Quantas delegações houve e quantas ainda estão em voo.
export function delegationSummary(steps = []) {
  const delegations = steps.filter(step => step?.name === SUBAGENT_TOOL);
  return {
    total: delegations.length,
    running: delegations.filter(step => step.status === 'running').length,
    // Nomes dos sub-agentes que aparecem nas etapas filhas, sem repetir.
    names: [...new Set(steps.map(step => step?.subagent).filter(Boolean))]
  };
}
