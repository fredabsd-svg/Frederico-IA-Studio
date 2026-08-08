// Handoff local ↔ worktree (Fase 24 do Developer Workspace 3.0).
//
// O trabalho da tarefa mora no clone da conversa (/workspace/repo/<nome>), na
// branch derivada da Fase 23 — o efeito prático de um worktree por tarefa. Até
// aqui esse trabalho só saía dali por `github_push` + Pull Request, o que exige
// autorização de escrita, remoto e conexão. Duas situações ficavam sem saída:
//
//   1. o usuário quer CONTINUAR na máquina dele (rodar o app, abrir a IDE,
//      depurar) — e o trabalho NÃO COMMITADO nunca chegava lá;
//   2. o usuário já corrigiu algo localmente e quer DEVOLVER para a tarefa, sem
//      passar pelo GitHub.
//
// Este módulo faz a ponte nos dois sentidos, na mesma camada do ChangeSet e do
// diff por arquivo: git local no clone, sem token e sem sandbox.
//
// Três decisões que moldam o comportamento:
//
//   * **O patch é o caminho universal; a worktree é o caminho bom.** Quando a
//     branch já está publicada, o usuário abre uma `git worktree` ao lado do
//     clone dele e o checkout atual não é tocado. Quando NÃO está (o caso mais
//     comum: trabalho ainda não commitado), o patch é a única ponte honesta —
//     e ele carrega inclusive os arquivos novos.
//   * **Aplicar patch não faz merge de três vias.** `git apply` com `--check`
//     antes: se o patch não casa com o estado atual, nada acontece e o usuário
//     lê o motivo. Um `--3way` deixaria marcadores de conflito dentro dos
//     arquivos da tarefa — o oposto do que este projeto faz em toda operação
//     destrutiva (recusar é previsível; aplicar torto, não).
//   * **Caminho de patch é conferido, não normalizado.** Caminho absoluto ou
//     com `..` é RECUSADO nomeando o caminho, como no diffView.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { workspaceFor } from '../sandbox.js';
import { runGit, chownTree, isValidBranchName } from '../connectors/github.js';

const MAX_REPOS = 3;
// Teto do patch nos dois sentidos. Generoso para caber um `--binary` com
// imagens, apertado o bastante para não virar upload de arquivo grande.
export const MAX_PATCH_CHARS = 2_000_000;

// O git embrulha caminho com caractere especial em aspas ("a b.txt").
function unquote(value) {
  const s = String(value || '').trim();
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

// URL do remoto SEM credencial embutida. O clone deste projeto usa cabeçalho de
// autorização (o token não entra na URL), mas um repositório clonado à mão pelo
// bash pode ter `https://usuario:token@github.com/...` — e essa URL vai para a
// tela e para a área de transferência do usuário.
export function sanitizeRemoteUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  return url.replace(/^(https?:\/\/)[^/@]*@/, '$1');
}

// "https://github.com/dono/repo.git" | "git@github.com:dono/repo.git" → "dono/repo"
export function repoFullNameFromRemote(raw) {
  const url = sanitizeRemoteUrl(raw);
  if (!url) return null;
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Pasta sugerida para a worktree local: irmã do clone do usuário, nomeada pela
// branch (`/` vira `-`, porque a barra criaria subpasta).
export function worktreeDirFor(repoName, branch) {
  const slug = String(branch || '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\//g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'tarefa';
  const base = String(repoName || 'repo').replace(/[^A-Za-z0-9._-]+/g, '-') || 'repo';
  return `../${base}-${slug}`;
}

// OS COMANDOS, puros e testáveis. O usuário roda estes no clone dele — por isso
// nada aqui é executado pelo servidor: o servidor não tem (nem deve ter) acesso
// à máquina do usuário.
export function buildHandoffCommands({ repoName = 'repo', branch = null, base = null, published = false, dirty = 0, patchAvailable = null, patchName = 'tarefa.patch' } = {}) {
  const temPatch = patchAvailable == null ? dirty > 0 : Boolean(patchAvailable);
  const dir = worktreeDirFor(repoName, branch);
  const safeBranch = branch && isValidBranchName(branch) ? branch : null;
  const toLocal = [];

  if (safeBranch && published) {
    toLocal.push({ label: 'Trazer a branch da tarefa', command: `git fetch origin ${safeBranch}` });
    toLocal.push({
      label: 'Abrir numa worktree ao lado (o seu checkout atual não é tocado)',
      command: `git worktree add --track -b ${safeBranch} ${dir} origin/${safeBranch}`
    });
    toLocal.push({
      label: 'Se a branch já existir aqui, use esta em vez da anterior',
      command: `git worktree add ${dir} ${safeBranch}`
    });
    toLocal.push({ label: 'Ao terminar, remover a worktree (a branch continua)', command: `git worktree remove ${dir}` });
  }
  if (temPatch) {
    toLocal.push({
      label: published
        ? 'O que ainda não foi publicado vai no patch — aplique-o dentro da worktree'
        : 'A branch ainda não foi publicada: o patch é o caminho',
      command: `git apply ${patchName}`
    });
  }

  // Sentido inverso: o que o usuário roda na máquina dele para gerar o patch que
  // será colado no painel. O `add -N` é o que faz os arquivos NOVOS entrarem no
  // `git diff` — sem ele, um arquivo criado localmente sumiria do handoff.
  const toWorktree = [
    { label: 'Marcar os arquivos novos para que entrem no diff', command: 'git add -N .' },
    { label: 'Gerar o patch do seu trabalho não commitado', command: 'git diff HEAD --binary > meu.patch' },
    { label: 'Já commitou? Gere o patch dos commits que a tarefa não tem', command: `git diff --binary ${safeBranch && published ? `origin/${safeBranch}` : base || 'origin/HEAD'}..HEAD > meu.patch` }
  ];

  return { toLocal, toWorktree, worktreeDir: dir };
}

// INSPEÇÃO DO PATCH, pura. Devolve os arquivos de destino ou o motivo da recusa.
export function inspectPatch(raw, { maxChars = MAX_PATCH_CHARS } = {}) {
  let text = String(raw || '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);       // BOM de editor Windows
  if (!text.trim()) return { error: 'O patch está vazio.' };
  if (text.length > maxChars) {
    return { error: `O patch tem ${text.length} caracteres — o limite é ${maxChars}. Divida-o ou publique a branch e use o GitHub.` };
  }
  if (!/^diff --git /m.test(text)) {
    return { error: 'Isto não parece um patch do git. Gere com "git diff HEAD --binary > meu.patch" e cole o conteúdo inteiro do arquivo.' };
  }
  // Os caminhos saem das linhas `---`/`+++` (uma por linha, sem ambiguidade) e
  // não do cabeçalho `diff --git a/x b/x`, onde um nome com espaço não pode ser
  // separado com segurança.
  const files = new Set();
  for (const line of text.split('\n')) {
    const m = /^(?:---|\+\+\+) (.+)$/.exec(line);
    if (!m) continue;
    let p = m[1].split('\t')[0].trim();                           // alguns geradores anexam data após TAB
    if (p === '/dev/null') continue;
    p = unquote(p).replace(/^[ab]\//, '');
    if (p) files.add(p);
  }
  if (!files.size) return { error: 'O patch não indica nenhum arquivo de destino.' };
  for (const p of files) {
    if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.split(/[\\/]/).includes('..')) {
      return { error: `O patch aponta para fora do repositório da tarefa: ${p}` };
    }
  }
  return { files: [...files] };
}

// Clones utilizáveis da conversa (mesma varredura do ChangeSet).
function repoDirs(userId, conversationId) {
  const root = path.join(workspaceFor(conversationId, userId).base, 'repo');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.git')))
      .slice(0, MAX_REPOS)
      .map(entry => ({ name: entry.name, dir: path.join(root, entry.name) }));
  } catch {
    return [];
  }
}

function findRepo(userId, conversationId, repoName) {
  const clean = String(repoName || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!clean) return null;
  return repoDirs(userId, conversationId).find(entry => entry.name === clean) || null;
}

// ESTADO DO HANDOFF: o que existe para levar, e por qual caminho.
export async function handoffSnapshot(userId, conversationId) {
  const repos = [];
  for (const { name, dir } of repoDirs(userId, conversationId)) {
    const branchResult = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
    const remoteResult = await runGit(dir, ['remote', 'get-url', 'origin']);
    const remote = remoteResult.code === 0 ? sanitizeRemoteUrl(remoteResult.stdout.trim()) : null;
    const statusResult = await runGit(dir, ['status', '--porcelain']);
    if (statusResult.code !== 0) continue;                        // não é um repo utilizável
    const dirty = statusResult.stdout.split('\n').filter(line => line.trim()).length;

    // "Publicada" é lido do ref de rastreamento local: o `github_push` atualiza
    // `refs/remotes/origin/<branch>`, então isto reflete o último push feito
    // pela tarefa sem precisar falar com o GitHub (nem de token).
    let published = false;
    let ahead = null;
    if (branch && branch !== 'HEAD') {
      const ref = await runGit(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
      published = ref.code === 0;
      if (published) {
        const count = await runGit(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]);
        ahead = count.code === 0 ? Number(count.stdout.trim()) || 0 : null;
      }
    }
    // Há patch quando existe trabalho não commitado OU commits que o remoto
    // ainda não recebeu (estes últimos a worktree não traria).
    const patchAvailable = dirty > 0 || (ahead || 0) > 0;
    repos.push({
      name,
      branch,
      remote,
      fullName: repoFullNameFromRemote(remote),
      published,
      ahead,
      dirty,
      patchAvailable,
      commands: buildHandoffCommands({ repoName: name, branch, published, dirty, patchAvailable, patchName: `${name}.patch` })
    });
  }
  return { repos };
}

// A BASE do patch exportado. Quando a branch já está publicada mas tem commits
// locais que o remoto não recebeu, `HEAD` deixaria esses commits de fora: a
// worktree traria o que foi publicado, o patch traria só o não commitado, e o
// trabalho no meio evaporaria — o pior desfecho possível para um handoff.
// Com `origin/<branch>` o patch cobre commits locais E trabalho não commitado
// num arquivo só, aplicável sobre a worktree recém-aberta.
async function patchBaseFor(dir, branch) {
  if (!branch || branch === 'HEAD' || !isValidBranchName(branch)) return { base: 'HEAD', commits: 0 };
  const ref = await runGit(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (ref.code !== 0) return { base: 'HEAD', commits: 0 };
  const count = await runGit(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]);
  const commits = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
  return commits > 0 ? { base: `origin/${branch}`, commits } : { base: 'HEAD', commits: 0 };
}

// EXPORTAR o trabalho da tarefa como patch aplicável.
//
// `git diff` sozinho ignora arquivo NÃO RASTREADO — e arquivo novo é justamente
// o que a IA mais produz. A saída é montada num ÍNDICE TEMPORÁRIO
// (`GIT_INDEX_FILE`): o `add -A` enxerga tudo, e o índice de verdade do clone
// não é tocado, então a tarefa continua exatamente como estava.
export async function exportPatch(userId, conversationId, { repo } = {}) {
  const found = findRepo(userId, conversationId, repo);
  if (!found) return { error: 'Repositório não encontrado nesta conversa.' };
  const branchResult = await runGit(found.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const { base, commits } = await patchBaseFor(found.dir, branch);
  const indexFile = path.join(os.tmpdir(), `frederico-handoff-${process.pid}-${Date.now()}.index`);
  try {
    const staged = await runGit(found.dir, ['add', '-A'], { env: { GIT_INDEX_FILE: indexFile } });
    if (staged.code !== 0) {
      return { error: `Não foi possível montar o patch: ${(staged.stderr || '').slice(0, 200)}` };
    }
    const diff = await runGit(found.dir, ['diff', '--cached', '--binary', '--no-color', base], {
      env: { GIT_INDEX_FILE: indexFile },
      maxOutput: MAX_PATCH_CHARS
    });
    if (diff.code !== 0) {
      return { error: `Não foi possível gerar o patch: ${(diff.stderr || '').slice(0, 200)}` };
    }
    const patch = diff.stdout;
    if (!patch.trim()) return { error: 'Não há trabalho para levar — o repositório da tarefa está limpo e nada ficou por publicar.' };
    return { patch: patch.endsWith('\n') ? patch : `${patch}\n`, repo: found.name, base, commits };
  } finally {
    try { fs.rmSync(indexFile, { force: true }); } catch { /* índice temporário: sumir é o resultado desejado */ }
  }
}

// APLICAR um patch vindo do computador do usuário no clone da tarefa.
export async function applyPatch(userId, conversationId, { repo, patch } = {}) {
  const inspection = inspectPatch(patch);
  if (inspection.error) return { error: inspection.error };
  const found = findRepo(userId, conversationId, repo);
  if (!found) return { error: 'Repositório não encontrado nesta conversa.' };

  let text = String(patch);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.endsWith('\n')) text += '\n';                         // git apply recusa patch sem quebra final

  // `--check` primeiro: ou o patch inteiro se aplica, ou nada é escrito.
  const check = await runGit(found.dir, ['apply', '--check', '--whitespace=nowarn', '-'], { stdin: text });
  if (check.code !== 0) {
    const detail = (check.stderr || '').trim().slice(0, 400);
    return {
      error: `O patch não se aplica ao estado atual do repositório da tarefa — nada foi alterado. Gere o patch a partir do mesmo ponto (ou traga primeiro as alterações da tarefa) e tente de novo.\n\n${detail}`
    };
  }
  const applied = await runGit(found.dir, ['apply', '--whitespace=nowarn', '-'], { stdin: text });
  if (applied.code !== 0) {
    return { error: `O patch passou na conferência mas falhou ao ser aplicado: ${(applied.stderr || '').trim().slice(0, 400)}` };
  }
  // Escrevemos como root; o sandbox roda como uid 1000 e precisa poder editar
  // depois o arquivo que acabou de receber.
  await chownTree(found.dir);
  return { ok: true, repo: found.name, files: inspection.files };
}
