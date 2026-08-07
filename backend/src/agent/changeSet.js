// ChangeSet REAL do Modo Desenvolvedor (Fases 26–27 do Developer Workspace 3.0).
//
// A aba "Alterações" da interface exibia uma pista honesta mas heurística
// (selo M/A deduzido de write_file). Este módulo devolve a VERDADE do git
// sobre o clone da conversa: `git status --porcelain` (o que mudou) +
// `git diff HEAD --numstat` (+linhas/−linhas), lidos pelo backend no
// workspace — sem token (leitura local) e sem passar pelo sandbox.
//
// Limites honestos: cobre apenas repositórios git em /workspace/repo/*
// (o vínculo por pasta do PC ou workspace sem git devolve lista vazia e a UI
// mantém o fallback heurístico); arquivos novos não rastreados aparecem como
// "A" sem contagem de linhas (o numstat não os cobre).
import fs from 'fs';
import path from 'path';
import { workspaceFor } from '../sandbox.js';
import { runGit } from '../connectors/github.js';

const MAX_REPOS = 3;
const MAX_FILES = 200;

// O git embrulha paths com caractere especial em aspas ("a b.txt"). Para a
// exibição basta remover as aspas — não interpretamos escapes de byte.
function unquote(value) {
  const s = String(value || '').trim();
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

// `git status --porcelain` → [{ path, status, from?, untracked }]
// status: A (novo, inclui não rastreado), M, D, R (renomeado, com `from`).
export function parseStatusPorcelain(stdout) {
  const files = [];
  for (const raw of String(stdout || '').split('\n')) {
    if (!raw.trim()) continue;
    const xy = raw.slice(0, 2);
    let rest = raw.slice(3);
    let from = null;
    if (/[RC]/.test(xy) && rest.includes(' -> ')) {
      const parts = rest.split(' -> ');
      from = unquote(parts[0]);
      rest = parts[1];
    }
    const status = xy === '??'
      ? 'A'
      : /[RC]/.test(xy)
        ? 'R'
        : xy.includes('D')
          ? 'D'
          : xy.includes('A')
            ? 'A'
            : 'M';
    files.push({ path: unquote(rest), status, ...(from ? { from } : {}), untracked: xy === '??' });
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

// `git diff HEAD --numstat` → Map(path → { additions, deletions }).
// Binários vêm como "-" (viram null). Renomeações usam `{a => b}`/`a => b` no
// path — normalizamos para o caminho NOVO, suficiente para casar com o status.
export function parseNumstat(stdout) {
  const byPath = new Map();
  for (const raw of String(stdout || '').split('\n')) {
    if (!raw.trim()) continue;
    const [adds, dels, ...restParts] = raw.split('\t');
    if (restParts.length === 0) continue;
    let filePath = restParts.join('\t');
    if (filePath.includes(' => ')) {
      // "src/{a.js => b.js}" → "src/b.js"; "a.js => b.js" → "b.js"
      filePath = filePath.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2').replace(/^[^{}]* => /, '');
      filePath = filePath.replace(/\/\//g, '/');
    }
    byPath.set(unquote(filePath), {
      additions: adds === '-' ? null : Number(adds) || 0,
      deletions: dels === '-' ? null : Number(dels) || 0
    });
  }
  return byPath;
}

// Junta status + numstat de UM repositório clonado.
export function mergeChanges(statusFiles, numstatByPath) {
  const files = statusFiles.map(file => {
    const stats = numstatByPath.get(file.path) || null;
    return {
      ...file,
      additions: stats ? stats.additions : null,
      deletions: stats ? stats.deletions : null
    };
  });
  const totals = files.reduce((acc, file) => ({
    files: acc.files + 1,
    additions: acc.additions + (file.additions || 0),
    deletions: acc.deletions + (file.deletions || 0)
  }), { files: 0, additions: 0, deletions: 0 });
  return { files, totals };
}

// Diff unificado (texto) dos clones da conversa — insumo do review gate, que
// precisa das LINHAS ADICIONADAS, não só dos nomes de arquivo. Limitado para
// não crescer sem teto num commit gigante.
export async function collectConversationDiff(userId, conversationId, { maxChars = 400_000 } = {}) {
  const root = path.join(workspaceFor(conversationId, userId).base, 'repo');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.git')))
      .slice(0, MAX_REPOS);
  } catch {
    return '';
  }
  const parts = [];
  let size = 0;
  for (const entry of entries) {
    // `--no-color`/`-U0` mantêm o texto compacto: o gate só lê linhas '+'.
    const result = await runGit(path.join(root, entry.name), ['diff', 'HEAD', '--no-color', '-U0']);
    if (result.code !== 0 || !result.stdout) continue;
    const chunk = result.stdout.slice(0, Math.max(0, maxChars - size));
    parts.push(chunk);
    size += chunk.length;
    if (size >= maxChars) break;
  }
  return parts.join('\n');
}

// Alterações reais de TODOS os clones da conversa (normalmente um).
export async function collectConversationChanges(userId, conversationId) {
  const root = path.join(workspaceFor(conversationId, userId).base, 'repo');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.git')))
      .slice(0, MAX_REPOS);
  } catch {
    return { repos: [] };
  }
  const repos = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    const [branchResult, statusResult, numstatResult] = [
      await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      await runGit(dir, ['status', '--porcelain']),
      await runGit(dir, ['diff', 'HEAD', '--numstat'])
    ];
    if (statusResult.code !== 0) continue; // não é um repo utilizável — sem inventar
    const merged = mergeChanges(
      parseStatusPorcelain(statusResult.stdout),
      numstatResult.code === 0 ? parseNumstat(numstatResult.stdout) : new Map()
    );
    repos.push({
      name: entry.name,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
      ...merged
    });
  }
  return { repos };
}
