// Diff por arquivo e REVERSÃO por hunk (Fase 27 completa do Developer
// Workspace 3.0).
//
// A aba "Alterações" já mostrava a verdade do git (Frente 18: status + ±linhas).
// Faltava o que a Fase 27 pede: ver o diff do arquivo e poder DESFAZER — o
// arquivo inteiro ou um pedaço dele — quando a IA mexeu no que não devia.
//
// Duas garantias que moldam o módulo:
//  1. reverter é operação DESTRUTIVA sobre trabalho não commitado. Ela só
//     acontece por clique do usuário (a autorização é o próprio clique, como no
//     botão de push), sobre um arquivo do repositório da PRÓPRIA conversa, e o
//     backend recusa qualquer caminho que escape do clone;
//  2. reverter um HUNK usa `git apply --reverse` com um patch reconstruído a
//     partir do diff atual — nunca edição de texto na mão. Se o arquivo mudou
//     desde que o diff foi lido, o git recusa o patch e nada acontece (em vez
//     de aplicar no lugar errado).
import fs from 'fs';
import path from 'path';
import { workspaceFor } from '../sandbox.js';
import { runGit } from '../connectors/github.js';

const MAX_DIFF_CHARS = 300_000;

// Quebra o diff de UM arquivo nos seus hunks. Puro e testável.
// Cada hunk guarda o cabeçalho (@@ ...) e as linhas, para poder ser reaplicado
// isoladamente como patch.
export function parseHunks(diffText) {
  const lines = String(diffText || '').split('\n');
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      current = {
        index: hunks.length,
        header: line,
        oldStart: match ? Number(match[1]) : 0,
        newStart: match ? Number(match[3]) : 0,
        additions: 0,
        deletions: 0,
        lines: []
      };
      continue;
    }
    if (!current) {
      // Cabeçalho do arquivo (diff --git, index, ---, +++): preservado para
      // remontar um patch válido na reversão.
      if (line.length) header.push(line);
      continue;
    }
    if (line.startsWith('+')) current.additions += 1;
    else if (line.startsWith('-')) current.deletions += 1;
    current.lines.push(line);
  }
  if (current) hunks.push(current);
  return { header, hunks };
}

// Remonta um patch com UM único hunk — o que será revertido.
export function buildHunkPatch(header, hunk) {
  if (!hunk) return '';
  const head = header.filter(line => /^(?:diff --git|index |--- |\+\+\+ |old mode|new mode|similarity|rename )/.test(line));
  return `${[...head, hunk.header, ...hunk.lines].join('\n')}\n`;
}

// Caminho do clone dentro do workspace da conversa, com CONTENÇÃO: o
// repositório precisa existir e o arquivo precisa cair dentro dele.
function resolveRepoFile(userId, conversationId, repoName, filePath) {
  const base = workspaceFor(conversationId, userId).base;
  const root = path.join(base, 'repo');
  const cleanRepo = String(repoName || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!cleanRepo) return null;
  const repoDir = path.resolve(root, cleanRepo);
  if (repoDir !== path.join(root, cleanRepo)) return null;         // travessia no nome do repo
  if (!fs.existsSync(path.join(repoDir, '.git'))) return null;
  const rel = String(filePath || '').replaceAll('\\', '/');
  // Caminho ABSOLUTO é recusado, não normalizado: reinterpretar "/etc/passwd"
  // como "<repo>/etc/passwd" ficaria contido, mas esconderia do usuário (e de
  // quem lê o log) o que ele de fato pediu. Recusar é previsível.
  if (!rel || rel.startsWith('/') || rel.includes('..')) return null;
  const target = path.resolve(repoDir, rel);
  if (target !== path.join(repoDir, rel)) return null;             // travessia no caminho
  if (!target.startsWith(repoDir + path.sep)) return null;
  return { repoDir, rel, target };
}

// Diff de um arquivo do clone, já em hunks. `staged=false` cobre o caso normal
// (trabalho não commitado); arquivo NOVO (não rastreado) não tem diff contra
// HEAD, então o conteúdo é apresentado como um hunk de adição.
export async function fileDiff(userId, conversationId, { repo, file }) {
  const resolved = resolveRepoFile(userId, conversationId, repo, file);
  if (!resolved) return { error: 'Arquivo fora do repositório desta conversa.' };
  const { repoDir, rel, target } = resolved;
  const tracked = await runGit(repoDir, ['ls-files', '--error-unmatch', '--', rel]);
  if (tracked.code !== 0) {
    // Não rastreado: mostra o conteúdo como adição, sem inventar um diff do git.
    let content = '';
    try { content = fs.readFileSync(target, 'utf8').slice(0, MAX_DIFF_CHARS); } catch { return { error: 'Não foi possível ler o arquivo.' }; }
    const linhas = content.split('\n');
    return {
      file: rel,
      untracked: true,
      header: [],
      hunks: [{ index: 0, header: `@@ -0,0 +1,${linhas.length} @@`, oldStart: 0, newStart: 1, additions: linhas.length, deletions: 0, lines: linhas.map(l => `+${l}`) }]
    };
  }
  const result = await runGit(repoDir, ['diff', 'HEAD', '--no-color', '--', rel]);
  if (result.code !== 0) return { error: 'Não foi possível ler o diff deste arquivo.' };
  const parsed = parseHunks(result.stdout.slice(0, MAX_DIFF_CHARS));
  return { file: rel, untracked: false, ...parsed };
}

// Reverte o arquivo INTEIRO (volta ao estado do último commit) ou UM hunk.
// Arquivo não rastreado é removido (é o "desfazer" natural de uma criação).
export async function revertChange(userId, conversationId, { repo, file, hunkIndex = null }) {
  const resolved = resolveRepoFile(userId, conversationId, repo, file);
  if (!resolved) return { error: 'Arquivo fora do repositório desta conversa.' };
  const { repoDir, rel, target } = resolved;
  const tracked = await runGit(repoDir, ['ls-files', '--error-unmatch', '--', rel]);

  if (tracked.code !== 0) {
    if (hunkIndex != null) return { error: 'Este arquivo é novo (não rastreado): só é possível descartá-lo inteiro.' };
    try { fs.rmSync(target, { force: true }); } catch { return { error: 'Não foi possível remover o arquivo.' }; }
    return { ok: true, file: rel, reverted: 'file', removed: true };
  }

  if (hunkIndex == null) {
    // Arquivo inteiro: restaura do HEAD (e tira do índice, se estava staged).
    const restore = await runGit(repoDir, ['checkout', 'HEAD', '--', rel]);
    if (restore.code !== 0) return { error: `Não foi possível reverter o arquivo: ${(restore.stderr || '').slice(0, 200)}` };
    return { ok: true, file: rel, reverted: 'file' };
  }

  const current = await runGit(repoDir, ['diff', 'HEAD', '--no-color', '--', rel]);
  if (current.code !== 0) return { error: 'Não foi possível ler o diff deste arquivo.' };
  const { header, hunks } = parseHunks(current.stdout);
  const hunk = hunks[Number(hunkIndex)];
  if (!hunk) return { error: 'Este trecho não existe mais no diff atual — recarregue as alterações.' };
  const patch = buildHunkPatch(header, hunk);
  // `git apply --reverse` valida o contexto: se o arquivo mudou desde a leitura
  // do diff, o patch é RECUSADO e nada é aplicado — melhor que aplicar torto.
  const applied = await runGit(repoDir, ['apply', '--reverse', '--unidiff-zero', '-'], { stdin: patch });
  if (applied.code !== 0) {
    return { error: `O trecho não pôde ser revertido (o arquivo mudou desde que o diff foi lido). Recarregue as alterações e tente de novo. ${(applied.stderr || '').slice(0, 200)}`.trim() };
  }
  return { ok: true, file: rel, reverted: 'hunk', hunkIndex: Number(hunkIndex) };
}
