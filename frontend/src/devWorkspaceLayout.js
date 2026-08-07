// Layout e contexto de sessão do Developer Workspace (Fases 51, 52 e 55).
//
// Este módulo é PURO de propósito: a grade de três colunas + terminal +
// compositor já existe e funciona (e mexer nela sem prova visual é o caminho
// mais curto para o defeito que já mordeu este projeto três vezes — compositor
// empurrado para fora da tela, mascote sobre o botão de enviar). O que faltava
// era DECIDIR, de forma testável:
//
//   * o que a sessão anuncia ao começar — projeto, branch de trabalho,
//     ambiente, modelo e permissões (Fase 55);
//   * quanto do workspace aparece por padrão — simplicidade progressiva
//     (Fase 52): começa em Chat + Tarefa + Terminal, e o resto (Alterações,
//     Agentes, Contexto, Git) entra sob demanda.
//
// Nada aqui inventa estado: cada item devolve `null` quando o dado real não
// existe, e quem renderiza simplesmente não mostra a linha.

export const LAYOUT_LEVELS = Object.freeze(['simples', 'completo']);
export const DEFAULT_LAYOUT_LEVEL = 'simples';
export const LAYOUT_KEY = 'fred_dev_layout_v1';

export function normalizeLayoutLevel(value) {
  return LAYOUT_LEVELS.includes(String(value || '')) ? String(value) : DEFAULT_LAYOUT_LEVEL;
}

// Quais painéis o workspace mostra. No nível simples as colunas laterais
// COMEÇAM recolhidas — mas a escolha explícita do usuário (ele abriu o rail)
// sempre vence: simplicidade progressiva não pode desfazer um clique.
export function resolveLayout({ level = DEFAULT_LAYOUT_LEVEL, leftCollapsed = null, rightCollapsed = null } = {}) {
  const simple = normalizeLayoutLevel(level) === 'simples';
  return {
    level: simple ? 'simples' : 'completo',
    // `null` = o usuário ainda não decidiu; o padrão do nível manda.
    leftCollapsed: leftCollapsed == null ? simple : Boolean(leftCollapsed),
    rightCollapsed: rightCollapsed == null ? simple : Boolean(rightCollapsed),
    // O terminal e o plano acompanham o chat nos dois níveis: são o mínimo
    // que responde "o que está acontecendo agora?".
    showTerminal: true,
    showPlan: true,
    // Abas avançadas do rail direito. No simples, Atividade basta.
    railTabs: simple ? ['atividade'] : ['atividade', 'arquivos', 'alteracoes', 'memoria']
  };
}

// Rótulo honesto do ambiente de execução da tarefa.
export function environmentLabel(session) {
  if (!session) return null;
  if (session.github?.repo) return `Repositório ${session.github.repo}`;
  if (session.projectId) return 'Pasta do PC';
  return 'Sandbox da conversa';
}

// Resumo das permissões concedidas, em texto curto. Sem permissão nenhuma,
// devolve "somente leitura" — que é a verdade, não um vazio ambíguo.
export function permissionsLabel({ session = null, canWrite = false } = {}) {
  const perms = session?.permissions || null;
  const partes = [];
  if (canWrite) partes.push('escrita no projeto');
  if (perms?.githubWrite) partes.push('publicação');
  const grants = perms?.commandGrants?.length || 0;
  if (grants) partes.push(`${grants} comando${grants > 1 ? 's' : ''} autorizado${grants > 1 ? 's' : ''}`);
  return partes.length ? partes.join(' · ') : 'somente leitura';
}

// A linha de contexto que a sessão anuncia (Fase 55). Cada item traz `label` e
// `value`; itens sem dado real são omitidos — nunca preenchidos com placeholder.
//
// `preflight` é o estado REAL vindo do backend (githubPreflight): é dele que
// sai a branch de TRABALHO (que pode ser derivada da protegida). Sem preflight,
// mostramos a branch vinculada, que é o que sabemos com certeza.
export function sessionContextItems({ project = null, session = null, model = '', preflight = null, canWrite = false } = {}) {
  const items = [];
  if (project?.name) items.push({ key: 'projeto', label: 'Projeto', value: project.name });

  const branchTrabalho = preflight?.branch || session?.github?.branch || null;
  if (branchTrabalho) {
    items.push({
      key: 'branch',
      label: 'Branch',
      value: branchTrabalho,
      // Quando a branch é derivada, dizer de onde ela saiu evita a pergunta
      // "por que não estou na main?".
      note: preflight?.workBranchDerived ? `de trabalho (a partir de ${preflight.boundBranch || 'padrão'})` : null
    });
  }
  const ambiente = environmentLabel(session);
  if (ambiente) items.push({ key: 'ambiente', label: 'Ambiente', value: ambiente });

  // Modelo: só o id legível, sem o prefixo de provedor (que é ruído na barra).
  const modelo = String(model || '').split('::').pop();
  if (modelo) items.push({ key: 'modelo', label: 'Modelo', value: modelo });

  items.push({ key: 'permissoes', label: 'Permissões', value: permissionsLabel({ session, canWrite }) });
  return items;
}
