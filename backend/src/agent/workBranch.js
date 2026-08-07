// Branch de trabalho por tarefa (Fase 23 — decisão 2A do Developer Workspace 3.0).
//
// O isolamento de ARQUIVOS já existe: cada conversa tem seu próprio clone em
// /workspace/repo/<nome> (é o efeito prático de um worktree por tarefa). O que
// faltava era o isolamento de HISTÓRICO: com o vínculo apontando para `main`,
// uma tarefa de escrita commitava direto na branch protegida e a publicação
// empurrava para lá.
//
// Regra: em modo de ESCRITA (build/fix/auto), quando a branch vinculada é uma
// branch PROTEGIDA (main/master/develop...), o trabalho vai para uma branch
// derivada, determinística por conversa:
//
//     frederico/<slug-do-projeto>-<sufixo-da-conversa>
//
// Determinística de propósito: a mesma conversa retomada dias depois volta para
// a MESMA branch (sem criar uma branch nova por turno), e o pré-voo/PR podem
// citá-la antes de existir. Quem escolheu explicitamente uma branch de trabalho
// no vínculo continua mandando — a derivação só age sobre branch protegida.

// Nomes que ninguém deve receber commit direto de um agente.
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'trunk', 'release', 'producao', 'produção', 'prod']);

export const WORK_BRANCH_PREFIX = 'frederico';

export function isProtectedBranch(name) {
  return PROTECTED_BRANCHES.has(String(name || '').trim().toLowerCase());
}

// Pedaço legível e seguro para nome de branch (sem espaço, acento, barra ou
// caractere que o git recuse).
export function slugify(value, max = 32) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // tira acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

// Nome determinístico da branch de trabalho desta conversa.
export function workBranchNameFor({ projectName = '', conversationId = '' } = {}) {
  const slug = slugify(projectName) || 'tarefa';
  // Sufixo curto e estável da conversa: o id é opaco (nanoid), então bastam os
  // últimos caracteres alfanuméricos para não colidir dentro do mesmo projeto.
  const suffix = String(conversationId || '').replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase() || 'sessao';
  return `${WORK_BRANCH_PREFIX}/${slug}-${suffix}`;
}

// A DECISÃO, pura e testável: qual branch a tarefa deve usar, e por quê.
//
// - modo somente-leitura → nunca deriva (ninguém vai commitar);
// - branch vinculada não protegida → é a branch de trabalho (escolha explícita);
// - branch protegida (ou vínculo sem branch) em modo de escrita → deriva.
export function resolveWorkBranch({ boundBranch = '', canWrite = false, projectName = '', conversationId = '' } = {}) {
  const bound = String(boundBranch || '').trim();
  if (!canWrite) {
    return { branch: bound, derived: false, base: bound || null, reason: 'read_only' };
  }
  if (bound && !isProtectedBranch(bound)) {
    return { branch: bound, derived: false, base: null, reason: 'explicit_branch' };
  }
  const branch = workBranchNameFor({ projectName, conversationId });
  return {
    branch,
    derived: true,
    // A base do PR é a branch vinculada (ou a padrão do repositório quando o
    // vínculo não fixou nenhuma).
    base: bound || null,
    reason: bound ? 'protected_branch' : 'no_branch_bound'
  };
}

// Frase para o prompt/preflight quando a derivação acontece — o usuário e o
// modelo precisam saber ONDE o trabalho está sendo commitado.
export function workBranchNote(resolution) {
  if (!resolution?.derived) return '';
  const destino = resolution.base ? ` (o Pull Request terá "${resolution.base}" como base)` : '';
  return `BRANCH DE TRABALHO: esta tarefa commita em "${resolution.branch}"${destino}. ${resolution.reason === 'protected_branch'
    ? 'A branch vinculada é protegida — nunca commite direto nela.'
    : 'O vínculo não fixou uma branch de trabalho.'} A branch é criada no primeiro github_clone e reaproveitada nas retomadas desta conversa.`;
}
