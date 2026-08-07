// Estado do handoff local ↔ worktree, derivado do que o backend relatou
// (GET /conversations/:id/handoff). Puro: só decide qual dos caminhos existe e
// como dizer isso em uma frase.
//
// A distinção que importa é entre "publicada" e "com trabalho pendente": são
// eixos independentes, e o caso que mais confunde é o dos DOIS ao mesmo tempo —
// a worktree traz o que foi publicado, o patch traz o resto. Dizer só um dos
// dois faria o usuário levar metade do trabalho sem perceber.

function plural(n, singular, pluralWord) {
  return `${n} ${n === 1 ? singular : pluralWord}`;
}

// Descreve o que ficou de fora do que já está publicado.
function pendencia(repo) {
  const partes = [];
  if ((repo?.ahead || 0) > 0) partes.push(plural(repo.ahead, 'commit ainda não publicado', 'commits ainda não publicados'));
  if ((repo?.dirty || 0) > 0) partes.push(plural(repo.dirty, 'arquivo com alteração não commitada', 'arquivos com alterações não commitadas'));
  return partes.join(' e ');
}

export function handoffState(repo) {
  if (!repo) return { kind: 'nenhum', canWorktree: false, canPatch: false, summary: 'Nenhum repositório git nesta conversa.' };
  const branch = repo.branch || 'a branch da tarefa';
  const canWorktree = Boolean(repo.published);
  const canPatch = Boolean(repo.patchAvailable);

  if (canWorktree && canPatch) {
    return {
      kind: 'ambos',
      canWorktree,
      canPatch,
      summary: `A branch ${branch} está publicada, mas há ${pendencia(repo)}. A worktree traz o que já foi publicado; o patch traz o resto — use os dois.`
    };
  }
  if (canWorktree) {
    return {
      kind: 'worktree',
      canWorktree,
      canPatch,
      summary: `A branch ${branch} está publicada e não há nada pendente: abrir a worktree traz o trabalho inteiro.`
    };
  }
  if (canPatch) {
    return {
      kind: 'patch',
      canWorktree,
      canPatch,
      summary: `A branch ${branch} ainda não foi publicada — o patch é o caminho. Ele leva ${pendencia(repo)}, inclusive os arquivos novos.`
    };
  }
  return {
    kind: 'nada',
    canWorktree,
    canPatch,
    summary: `Nada para levar: ${branch} não foi publicada e o repositório da tarefa está limpo.`
  };
}
