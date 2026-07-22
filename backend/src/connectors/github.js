// Conector GitHub por usuário.
//
// SEGURANÇA (o desenho inteiro gira em torno disto):
// - O token (PAT) fica cifrado em user_connectors (AES-256-GCM, ENCRYPTION_KEY)
//   e NUNCA entra no sandbox: clone/pull/push rodam AQUI no backend, sobre o
//   workspace da conversa (que é bind-mount do sandbox). O modelo edita os
//   arquivos e usa git LOCAL (status/diff/commit) pelo bash do sandbox — só as
//   operações de rede passam pelas ferramentas github_* deste módulo.
// - A autenticação vai por http.extraheader POR INVOCAÇÃO (nunca na URL nem no
//   .git/config, que o sandbox enxerga). A saída de todo comando é esfregada
//   (scrubSecrets) antes de voltar ao modelo, por defesa em profundidade.
// - Após qualquer escrita do backend no repositório (clone/fetch/commit), o
//   diretório é re-chownado para uid 1000 — regra da casa: o exec do sandbox
//   roda como uid 1000 e escrita de root quebraria o git de dentro do sandbox.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from '../db.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { workspaceFor } from '../sandbox.js';

const GITHUB_API = 'https://api.github.com';
const CLONE_TIMEOUT_MS = Number(process.env.GITHUB_CLONE_TIMEOUT_MS || 300000);
const GIT_TIMEOUT_MS = Number(process.env.GITHUB_GIT_TIMEOUT_MS || 120000);

// ---- Definições das ferramentas oferecidas ao modelo (rodam no BACKEND) ----
export const githubToolDefinitions = [
  { type: 'function', function: { name: 'github_list_repos', description: 'Lista os repositórios GitHub da conta conectada do usuário (nome, branch padrão, privado ou público). Use quando precisar descobrir o nome exato de um repositório.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'github_clone', description: 'Clona (ou atualiza, se já clonado) um repositório GitHub do usuário para /workspace/repo/<nome> dentro do sandbox. A autenticação é do app — nunca peça token ao usuário. Depois do clone, leia e edite os arquivos normalmente com bash/run_python; git status/diff/commit funcionam pelo bash do sandbox.', parameters: { type: 'object', properties: { repo: { type: 'string', description: 'Nome completo owner/repositorio, ex.: fulano/meu-app' }, branch: { type: 'string', description: '(opcional) branch para trabalhar; se não existir, é criada a partir da branch padrão' } }, required: ['repo'] } } },
  { type: 'function', function: { name: 'github_push', description: 'Envia para o GitHub as mudanças do repositório clonado nesta conversa. Se houver mudanças não commitadas e você informar commit_message, faz o commit antes (git add -A). O push vai para a branch informada (ou a branch atual).', parameters: { type: 'object', properties: { repo: { type: 'string', description: 'Nome completo owner/repositorio já clonado nesta conversa' }, commit_message: { type: 'string', description: '(opcional) mensagem, em português, para commitar as mudanças pendentes antes do push' }, branch: { type: 'string', description: '(opcional) branch de destino no GitHub; padrão é a branch atual do clone' } }, required: ['repo'] } } },
  { type: 'function', function: { name: 'github_create_pr', description: 'Abre um Pull Request no GitHub do repositório clonado, da branch de trabalho (head) para a branch de destino (base, padrão: branch padrão do repositório). Faça github_push antes, para a branch existir no GitHub.', parameters: { type: 'object', properties: { repo: { type: 'string', description: 'Nome completo owner/repositorio' }, title: { type: 'string', description: 'Título do PR, em português' }, body: { type: 'string', description: '(opcional) descrição do PR' }, head: { type: 'string', description: '(opcional) branch de origem; padrão é a branch atual do clone' }, base: { type: 'string', description: '(opcional) branch de destino; padrão é a branch padrão do repositório' } }, required: ['repo', 'title'] } } }
];

export const GITHUB_WRITE_TOOLS = new Set(['github_push', 'github_create_pr']);

// ---- Helpers puros (testáveis) ----

// Valida "owner/repo" (formato aceito pelo GitHub; barra única, sem espaços).
export function isValidRepoFullName(value) {
  const s = String(value || '').trim();
  if (s.length < 3 || s.length > 180) return false;
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*)\/[A-Za-z0-9._-]+$/.test(s) && !s.includes('..');
}

// Nome de diretório do clone dentro de /workspace/repo (só a parte do repo).
export function repoDirName(fullName) {
  const repo = String(fullName || '').split('/')[1] || 'repo';
  return repo.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'repo';
}

// Nome de branch aceitável (evita injeção de flags tipo "--force" via argumento).
export function isValidBranchName(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 200 || s.startsWith('-')) return false;
  return /^[^\s~^:?*\[\\]+$/.test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
}

// Remove o token (e sua forma base64) de qualquer texto que volte ao modelo.
export function scrubSecrets(text, token) {
  let out = String(text || '');
  if (token) {
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
    out = out.split(token).join('***').split(b64).join('***');
  }
  return out;
}

// ---- Conexão salva do usuário ----

export async function getGithubConnection(userId) {
  if (!userId) return null;
  try {
    const row = await db.prepare("SELECT token_enc, account_login, account_name FROM user_connectors WHERE user_id=? AND provider='github'").get(userId);
    if (!row?.token_enc) return null; // nunca conectou: silêncio é correto
    const token = decryptSecret(row.token_enc);
    if (!token) {
      // A conexão EXISTE no banco, mas o token não descriptografou — quase
      // sempre a ENCRYPTION_KEY do servidor mudou entre deploys. Sem este log
      // o usuário via "não tenho acesso ao GitHub" sem nenhuma pista da causa.
      console.error(`[github] usuário ${userId} está conectado no banco, mas o token não descriptografou (ENCRYPTION_KEY mudou?). Tratando como desconectado — o usuário precisa reconectar em Configurações → Conectores.`);
      return null;
    }
    return { token, login: row.account_login || '', name: row.account_name || '' };
  } catch (e) {
    // Falha de banco/leitura: também era engolida em silêncio antes.
    console.error(`[github] falha ao ler a conexão do usuário ${userId}: ${e?.message || e}`);
    return null;
  }
}

export async function hasGithubConnection(userId) {
  return Boolean(await getGithubConnection(userId));
}

// Valida o token no GitHub e salva a conexão cifrada (usado pelo fluxo OAuth
// e pelo cadastro manual de token).
export async function saveGithubConnection(userId, token) {
  const test = await testGithubToken(token);
  if (!test.ok) return test;
  const t = now();
  await db.prepare(`INSERT INTO user_connectors (user_id, provider, token_enc, account_login, account_name, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (user_id, provider) DO UPDATE SET token_enc=excluded.token_enc, account_login=excluded.account_login, account_name=excluded.account_name, updated_at=excluded.updated_at`)
    .run(userId, 'github', encryptSecret(token), test.login, test.name, t, t);
  return { ok: true, login: test.login, name: test.name };
}

// ---- OAuth do GitHub (conexão em 1 clique, sem copiar token) ----
// Usa um OAuth App do GitHub dedicado ao conector (callback
// <BETTER_AUTH_URL>/api/connectors/github/callback). O "state" anti-CSRF fica
// em memória, amarrado ao usuário logado, com validade curta.

export function githubOAuthConfig() {
  const clientId = process.env.GITHUB_CONNECTOR_CLIENT_ID || '';
  const clientSecret = process.env.GITHUB_CONNECTOR_CLIENT_SECRET || '';
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function githubOAuthRedirectUri() {
  const base = (process.env.BETTER_AUTH_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/api/connectors/github/callback`;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map(); // state -> { userId, exp }

export function createGithubOAuthState(userId) {
  for (const [key, value] of oauthStates) if (value.exp < Date.now()) oauthStates.delete(key);
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, { userId: String(userId), exp: Date.now() + OAUTH_STATE_TTL_MS });
  return state;
}

// Consome (uso único) e valida o state: precisa existir, estar no prazo e
// pertencer ao MESMO usuário logado que iniciou o fluxo.
export function consumeGithubOAuthState(state, userId) {
  const entry = oauthStates.get(String(state || ''));
  if (entry) oauthStates.delete(String(state));
  return Boolean(entry && entry.exp >= Date.now() && entry.userId === String(userId));
}

export function githubOAuthAuthorizeUrl(state) {
  const cfg = githubOAuthConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: githubOAuthRedirectUri(),
    scope: 'repo',
    state
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeGithubOAuthCode(code) {
  const cfg = githubOAuthConfig();
  if (!cfg) return { ok: false, error: 'A conexão em 1 clique não está configurada neste servidor.' };
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'FredericoAIStudio/1.0' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: githubOAuthRedirectUri() })
    });
    const data = await r.json().catch(() => ({}));
    if (!data.access_token) {
      return { ok: false, error: data.error_description || data.error || 'O GitHub não devolveu a autorização. Tente conectar de novo.' };
    }
    return { ok: true, token: data.access_token };
  } catch {
    return { ok: false, error: 'Não foi possível falar com o GitHub agora. Tente novamente em instantes.' };
  }
}

// ---- API REST do GitHub (roda no backend, com o token do usuário) ----

async function githubApi(token, apiPath, { method = 'GET', body, signal, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
  const onAbort = () => ctl.abort(signal?.reason || 'aborted');
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(`${GITHUB_API}${apiPath}`, {
      method,
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'FredericoAIStudio/1.0',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, data };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Traduz as falhas mais comuns da API para uma frase útil em português.
function friendlyGithubError(status, data) {
  const msg = data?.message ? ` (${data.message})` : '';
  if (status === 401) return 'O GitHub recusou o token (expirado ou revogado). Reconecte em Configurações → Conectores.';
  if (status === 403) return `O token não tem permissão para esta ação${msg}. Confira os escopos do token (precisa de acesso "repo").`;
  if (status === 404) return 'Repositório não encontrado — confira o nome owner/repositorio e se o token tem acesso a ele.';
  if (status === 422) return `O GitHub rejeitou o pedido${msg}.`;
  return `O GitHub respondeu HTTP ${status}${msg}.`;
}

export async function testGithubToken(token, { signal } = {}) {
  try {
    const r = await githubApi(token, '/user', { signal });
    if (!r.ok) return { ok: false, error: friendlyGithubError(r.status, r.data) };
    return { ok: true, login: r.data.login || '', name: r.data.name || '' };
  } catch {
    return { ok: false, error: 'Não foi possível falar com o GitHub agora. Tente novamente em instantes.' };
  }
}

export async function listGithubRepos(token, { signal } = {}) {
  const r = await githubApi(token, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', { signal });
  if (!r.ok) return { error: friendlyGithubError(r.status, r.data) };
  const repos = (Array.isArray(r.data) ? r.data : []).map(x => ({
    full_name: x.full_name,
    private: !!x.private,
    default_branch: x.default_branch || 'main',
    description: x.description || '',
    pushed_at: x.pushed_at || null
  }));
  return { repos };
}

export async function listGithubBranches(token, fullName, { signal } = {}) {
  if (!isValidRepoFullName(fullName)) return { error: 'Nome de repositório inválido (use owner/repositorio).' };
  const r = await githubApi(token, `/repos/${fullName}/branches?per_page=100`, { signal });
  if (!r.ok) return { error: friendlyGithubError(r.status, r.data) };
  return { branches: (Array.isArray(r.data) ? r.data : []).map(b => b.name) };
}

// ---- Extrato do repositório (para dar CÓDIGO REAL aos modelos do multimodelo) ----
// Diferente do github_clone (que roda no sandbox, só no loop de ferramentas), isto
// lê a árvore e o conteúdo dos arquivos principais direto pela API do GitHub, no
// backend, e devolve um texto único pronto para injetar no prompt. Assim os modos
// compare/council/debate — que NÃO executam ferramentas — analisam o código de
// verdade em vez do "conhecimento geral" do modelo.

// Pastas e extensões que não ajudam na análise (dependências, binários, gerados).
const DIGEST_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', '.cache', 'target', '.turbo', '.idea', '.vscode', 'bin', 'obj']);
const DIGEST_SKIP_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'svg', 'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'mp4', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'flac', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'map', 'min', 'wasm', 'so', 'dll', 'dylib', 'exe', 'bin', 'class', 'jar', 'pyc', 'lock', 'pack', 'iso', 'db', 'sqlite']);
const DIGEST_SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'poetry.lock', 'gemfile.lock', 'cargo.lock']);
const DIGEST_MANIFESTS = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'composer.json', 'gemfile', 'makefile', 'tsconfig.json']);

export function isDigestIgnored(p) {
  const segments = String(p || '').split('/');
  if (segments.some(seg => DIGEST_IGNORE_DIRS.has(seg))) return true;
  const base = segments[segments.length - 1].toLowerCase();
  if (!base) return true;
  if (DIGEST_SKIP_FILES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  if (ext && DIGEST_SKIP_EXT.has(ext)) return true;
  return false;
}

// Prioriza o que melhor descreve o projeto: README e manifestos no topo, depois
// pontos de entrada (index/main/app/server), depois o restante do código-fonte.
// Empate: arquivo mais raso e menor primeiro (cabe mais coisa no orçamento).
export function digestFileScore(p, size = 0) {
  const segments = String(p || '').split('/');
  const base = segments[segments.length - 1].toLowerCase();
  const depth = segments.length;
  let score = 200 - depth * 8;
  if (/^readme/.test(base)) score += 1000;
  else if (DIGEST_MANIFESTS.has(base)) score += 600;
  if (/^(index|main|app|server|routes?|api|cli)\.[a-z]+$/.test(base)) score += 120;
  if (/\.(js|jsx|ts|tsx|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|kt|swift|vue|svelte|sql|sh|yml|yaml|toml)$/.test(base)) score += 40;
  if (/\.(md|txt|json|env|cfg|conf|ini)$/.test(base)) score += 10;
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(p) || /\.(test|spec)\./.test(base)) score -= 60;
  score -= Math.min(40, Math.floor((size || 0) / 4000)); // arquivos enormes descem
  return score;
}

// Seleção PURA (sem rede) dos arquivos que entram no extrato, respeitando o
// orçamento total estimado pelos tamanhos da árvore. Testável em isolamento.
export function pickDigestFiles(tree, { maxFiles = 26, maxChars = 46000, maxFileChars = 5000, maxFileBytes = 120000 } = {}) {
  const blobs = (Array.isArray(tree) ? tree : [])
    .filter(n => n?.type === 'blob' && typeof n.path === 'string' && !isDigestIgnored(n.path))
    .filter(n => !(Number.isFinite(n.size) && n.size > maxFileBytes))
    .map(n => ({ path: n.path, size: Number(n.size) || 0, score: digestFileScore(n.path, Number(n.size) || 0) }))
    .sort((a, b) => b.score - a.score || a.size - b.size || a.path.localeCompare(b.path));
  const picked = [];
  let estimate = 0;
  for (const b of blobs) {
    if (picked.length >= maxFiles || estimate >= maxChars) break;
    estimate += Math.min(b.size || maxFileChars, maxFileChars);
    picked.push(b);
  }
  return picked;
}

async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

// Monta o extrato (árvore + conteúdo dos arquivos principais) do repositório
// selecionado. Devolve null quando não há conexão/token ou o repo é inválido —
// o chamador então segue só com a nota textual (nome do repo), sem código.
export async function buildRepoDigest({ userId, repo, branch = null, signal, maxChars = 46000, maxFiles = 26, maxFileChars = 5000, treeListCap = 350 } = {}) {
  if (!isValidRepoFullName(repo)) return null;
  const conn = await getGithubConnection(userId);
  if (!conn) return null;
  const token = conn.token;
  try {
    // 1) Resolve a branch (a informada, se válida; senão a padrão do repo).
    let ref = branch && isValidBranchName(branch) ? branch : null;
    if (!ref) {
      const meta = await githubApi(token, `/repos/${repo}`, { signal });
      if (!meta.ok) return null;
      ref = meta.data.default_branch || 'main';
    }
    // 2) Árvore recursiva.
    const treeRes = await githubApi(token, `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { signal });
    if (!treeRes.ok) return null;
    const tree = Array.isArray(treeRes.data?.tree) ? treeRes.data.tree : [];
    const treeTruncated = !!treeRes.data?.truncated;
    if (!tree.length) return null;

    // 3) Escolhe os arquivos e busca o conteúdo (paralelismo modesto).
    const picked = pickDigestFiles(tree, { maxFiles, maxChars, maxFileChars });
    const fetched = await pool(picked, 6, async (f) => {
      try {
        const r = await githubApi(token, `/repos/${repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { signal });
        if (!r.ok || r.data?.type !== 'file' || r.data?.encoding !== 'base64') return null;
        const raw = Buffer.from(String(r.data.content || ''), 'base64').toString('utf8');
        if (/\u0000/.test(raw)) return null; // byte nulo = arquivo binário
        return { path: f.path, content: raw };
      } catch { return null; }
    });

    // 4) Monta o texto, respeitando o orçamento total de caracteres.
    const allPaths = tree.filter(n => n.type === 'blob' && !isDigestIgnored(n.path)).map(n => n.path).sort();
    const treeList = allPaths.slice(0, treeListCap).join('\n');
    const treeNote = allPaths.length > treeListCap || treeTruncated
      ? `\n… (${allPaths.length > treeListCap ? `${allPaths.length - treeListCap} arquivos a mais` : 'árvore parcial'}; extrato limitado por tamanho)`
      : '';

    const parts = [];
    let budget = maxChars;
    let includedFiles = 0;
    for (const f of fetched) {
      if (!f || budget <= 0) continue;
      const body = f.content.length > maxFileChars ? `${f.content.slice(0, maxFileChars)}\n… [arquivo truncado]` : f.content;
      const block = `### ${f.path}\n\`\`\`\n${scrubSecrets(body, token)}\n\`\`\``;
      if (block.length > budget && includedFiles > 0) continue;
      parts.push(block);
      budget -= block.length;
      includedFiles += 1;
    }
    if (!includedFiles) return null;

    const header = `EXTRATO REAL DO REPOSITÓRIO GitHub "${repo}" (branch "${ref}") — lido agora pela API do GitHub.\nBaseie sua análise NESTE código de verdade (não no seu conhecimento geral). Se algo não estiver no extrato, diga que precisa ver o arquivo específico, sem inventar.`;
    const text = `${header}\n\n## Estrutura de arquivos (${allPaths.length})\n${treeList}${treeNote}\n\n## Conteúdo dos arquivos principais (${includedFiles})\n\n${parts.join('\n\n')}`;
    return { text, ref, filesIncluded: includedFiles, totalFiles: allPaths.length, truncated: treeTruncated };
  } catch (err) {
    // Sem extrato (rede, permissão, repo grande demais): o multimodelo segue só
    // com a nota textual. Logamos para não mascarar token revogado / API fora.
    console.warn(`[github] buildRepoDigest falhou para "${repo}":`, err.message);
    return null;
  }
}

// ---- git no backend (nunca no sandbox: o token não pode vazar para lá) ----

function runGit(cwd, args, { token = null, timeoutMs = GIT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    const authArgs = token
      ? ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
      : [];
    // safe.directory: o backend roda como root sobre arquivos do uid 1000; sem
    // isto o git recusa com "detected dubious ownership".
    const child = spawn('git', ['-c', `safe.directory=${cwd}`, ...authArgs, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    let out = '', err = '', settled = false;
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: scrubSecrets(out, token).slice(-8000), stderr: (scrubSecrets(err, token) + extra).slice(-8000) });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(124, '\n[TIMEOUT: a operação git demorou demais]'); }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} finish(130, '\n[Cancelado pelo usuário]'); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish(-1, `\n${e.code === 'ENOENT' ? 'O git não está instalado no servidor. Reconstrua a imagem do backend (docker compose build backend).' : e.message}`));
    child.on('close', code => finish(code ?? -1));
  });
}

// Devolve a posse dos arquivos ao uid do sandbox após escrita do backend.
function chownTree(dir) {
  return new Promise((resolve) => {
    const child = spawn('chown', ['-R', '1000:1000', dir]);
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

function repoRoot(conversationId) {
  return path.join(workspaceFor(conversationId).base, 'repo');
}

function cloneDirFor(conversationId, fullName) {
  return path.join(repoRoot(conversationId), repoDirName(fullName));
}

async function currentBranch(dir) {
  const r = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

function toolError(error, extra = {}) {
  return { error, recoverable: true, ...extra };
}

const NOT_CONNECTED =
  'O GitHub não está conectado. Peça ao usuário para conectar a conta em Configurações → Conectores (token do GitHub).';

// ---- Implementação das ferramentas ----

async function githubClone(conn, conversationId, args, signal) {
  const fullName = String(args.repo || '').trim();
  if (!isValidRepoFullName(fullName)) return toolError('Nome de repositório inválido — use o formato owner/repositorio (ex.: fulano/meu-app).');
  const branch = String(args.branch || '').trim();
  if (branch && !isValidBranchName(branch)) return toolError(`Nome de branch inválido: "${branch}".`);
  const dir = cloneDirFor(conversationId, fullName);
  const sandboxPath = `/workspace/repo/${repoDirName(fullName)}`;

  if (fs.existsSync(path.join(dir, '.git'))) {
    // Já clonado nesta conversa: confere o remoto e atualiza.
    const remote = await runGit(dir, ['remote', 'get-url', 'origin']);
    const url = remote.stdout.trim();
    if (!url.includes(`github.com/${fullName}`)) {
      return toolError(`A pasta ${sandboxPath} já contém outro repositório (${url || 'desconhecido'}). Use o nome correto ou uma nova conversa.`);
    }
    const fetch_ = await runGit(dir, ['fetch', 'origin', '--prune'], { token: conn.token, timeoutMs: CLONE_TIMEOUT_MS, signal });
    if (fetch_.code !== 0) return toolError(`Não consegui atualizar o repositório: ${fetch_.stderr || fetch_.stdout}`.trim());
    if (branch) {
      const sw = await runGit(dir, ['checkout', branch], { signal });
      if (sw.code !== 0) {
        const swRemote = await runGit(dir, ['checkout', '-b', branch, `origin/${branch}`], { signal });
        if (swRemote.code !== 0) {
          const swNew = await runGit(dir, ['checkout', '-b', branch], { signal });
          if (swNew.code !== 0) return toolError(`Não consegui mudar para a branch "${branch}": ${swNew.stderr || sw.stderr}`.trim());
        }
      }
    }
    // ff-only: nunca cria merge sozinho; se divergiu, o modelo decide com o
    // usuário. Branch local nova (sem upstream) não tem o que puxar.
    const upstream = await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { signal });
    const pull = upstream.code === 0
      ? await runGit(dir, ['pull', '--ff-only', 'origin'], { token: conn.token, timeoutMs: CLONE_TIMEOUT_MS, signal })
      : { code: 0, stderr: '' };
    await chownTree(repoRoot(conversationId));
    const atualBranch = await currentBranch(dir);
    return {
      ok: true,
      updated: true,
      path: sandboxPath,
      branch: atualBranch,
      note: pull.code === 0
        ? `Repositório já estava clonado; atualizado a partir do GitHub. Trabalhe nos arquivos em ${sandboxPath}.`
        : `Repositório já estava clonado. Não foi possível avançar automaticamente (${(pull.stderr || '').trim().slice(0, 300)}) — provavelmente há mudanças locais; confira com git status/git log pelo bash.`
    };
  }

  fs.mkdirSync(repoRoot(conversationId), { recursive: true });
  const cloneArgs = ['clone', ...(branch ? ['--branch', branch, '--single-branch'] : []), `https://github.com/${fullName}.git`, dir];
  let clone = await runGit(repoRoot(conversationId), cloneArgs, { token: conn.token, timeoutMs: CLONE_TIMEOUT_MS, signal });
  let createdBranch = false;
  if (clone.code !== 0 && branch && /Remote branch .* not found|Could not find remote branch/i.test(clone.stderr)) {
    // Branch pedida ainda não existe no GitHub: clona a padrão e cria a branch.
    clone = await runGit(repoRoot(conversationId), ['clone', `https://github.com/${fullName}.git`, dir], { token: conn.token, timeoutMs: CLONE_TIMEOUT_MS, signal });
    if (clone.code === 0) {
      const nb = await runGit(dir, ['checkout', '-b', branch], { signal });
      createdBranch = nb.code === 0;
    }
  }
  if (clone.code !== 0) {
    const detail = (clone.stderr || clone.stdout || '').trim().slice(0, 400);
    if (/Authentication failed|could not read Username|403/i.test(detail)) {
      return toolError('O GitHub recusou a autenticação para este repositório. O token conectado precisa de acesso de leitura/escrita a ele (escopo "repo").');
    }
    if (/not found|Repository not found/i.test(detail)) {
      return toolError(`Repositório ${fullName} não encontrado — confira o nome e se o token tem acesso a ele.`);
    }
    return toolError(`O clone falhou: ${detail}`);
  }
  // Identidade local do git: os commits feitos pelo modelo (no sandbox) e pelo
  // github_push saem em nome da conta conectada, com o e-mail noreply do GitHub.
  await runGit(dir, ['config', 'user.name', conn.name || conn.login || 'Frederico AI Studio']);
  await runGit(dir, ['config', 'user.email', `${conn.login || 'frederico-ai'}@users.noreply.github.com`]);
  await chownTree(repoRoot(conversationId));
  const atual = await currentBranch(dir);
  return {
    ok: true,
    cloned: true,
    path: sandboxPath,
    branch: atual,
    ...(createdBranch ? { note: `A branch "${branch}" não existia no GitHub; foi criada localmente a partir da branch padrão e será enviada no primeiro github_push.` } : {}),
    hint: `Os arquivos estão em ${sandboxPath} (sandbox). Use bash/run_python para ler e editar; git status/diff/commit funcionam pelo bash. Para enviar ao GitHub, use github_push.`
  };
}

async function githubPush(conn, conversationId, args, signal) {
  const fullName = String(args.repo || '').trim();
  if (!isValidRepoFullName(fullName)) return toolError('Informe o repositório no formato owner/repositorio.');
  const dir = cloneDirFor(conversationId, fullName);
  if (!fs.existsSync(path.join(dir, '.git'))) return toolError(`O repositório ${fullName} ainda não foi clonado nesta conversa. Chame github_clone primeiro.`);
  const targetBranch = String(args.branch || '').trim();
  if (targetBranch && !isValidBranchName(targetBranch)) return toolError(`Nome de branch inválido: "${targetBranch}".`);

  const status = await runGit(dir, ['status', '--porcelain'], { signal });
  const dirty = status.code === 0 && status.stdout.trim().length > 0;
  const message = String(args.commit_message || '').trim();
  if (dirty) {
    if (!message) return toolError('Há mudanças ainda não commitadas. Informe commit_message (em português) para eu commitar antes do push, ou faça o commit pelo bash do sandbox.');
    const add = await runGit(dir, ['add', '-A'], { signal });
    if (add.code !== 0) return toolError(`git add falhou: ${(add.stderr || '').trim().slice(0, 300)}`);
    const commit = await runGit(dir, ['commit', '-m', message.slice(0, 2000)], { signal });
    if (commit.code !== 0) return toolError(`git commit falhou: ${(commit.stderr || commit.stdout || '').trim().slice(0, 300)}`);
  }

  const branch = targetBranch || await currentBranch(dir);
  if (!branch || branch === 'HEAD') return toolError('Não consegui identificar a branch atual do clone (HEAD solto). Informe a branch de destino no parâmetro branch.');

  // Sem commit para enviar?
  const ahead = await runGit(dir, ['rev-list', '--count', `origin/${branch}..HEAD`], { signal });
  if (!dirty && ahead.code === 0 && ahead.stdout.trim() === '0') {
    return { ok: true, branch, pushed: false, note: 'Nada novo para enviar: a branch já está igual ao GitHub.' };
  }

  const push = await runGit(dir, ['push', 'origin', `HEAD:refs/heads/${branch}`], { token: conn.token, signal });
  await chownTree(repoRoot(conversationId));
  if (push.code !== 0) {
    const detail = (push.stderr || push.stdout || '').trim().slice(0, 400);
    if (/non-fast-forward|fetch first|rejected/i.test(detail)) {
      return toolError(`O GitHub rejeitou o push (a branch "${branch}" avançou por fora). Rode github_clone de novo para atualizar (ou envie para outra branch) e tente outra vez.`);
    }
    if (/Authentication failed|403|permission/i.test(detail)) {
      return toolError('O token conectado não tem permissão de escrita neste repositório (escopo "repo" com acesso de escrita).');
    }
    return toolError(`O push falhou: ${detail}`);
  }
  const sha = await runGit(dir, ['rev-parse', '--short', 'HEAD'], { signal });
  return {
    ok: true,
    pushed: true,
    branch,
    commit: sha.code === 0 ? sha.stdout.trim() : null,
    note: `Mudanças enviadas para a branch "${branch}" de ${fullName}.`
  };
}

async function githubCreatePr(conn, conversationId, args, signal) {
  const fullName = String(args.repo || '').trim();
  if (!isValidRepoFullName(fullName)) return toolError('Informe o repositório no formato owner/repositorio.');
  const title = String(args.title || '').trim();
  if (!title) return toolError('Informe o título do Pull Request.');
  const dir = cloneDirFor(conversationId, fullName);
  let head = String(args.head || '').trim();
  if (!head && fs.existsSync(path.join(dir, '.git'))) head = (await currentBranch(dir)) || '';
  if (!head || !isValidBranchName(head)) return toolError('Não consegui identificar a branch de origem (head). Informe o parâmetro head.');
  let base = String(args.base || '').trim();
  if (!base) {
    const info = await githubApi(conn.token, `/repos/${fullName}`, { signal });
    base = info.ok ? (info.data.default_branch || 'main') : 'main';
  }
  if (head === base) return toolError(`A branch de origem e a de destino são a mesma ("${base}"). Envie o trabalho para outra branch com github_push e tente de novo.`);
  const r = await githubApi(conn.token, `/repos/${fullName}/pulls`, {
    method: 'POST',
    signal,
    body: { title: title.slice(0, 250), body: String(args.body || '').slice(0, 20000), head, base }
  });
  if (!r.ok) {
    const first = r.data?.errors?.[0]?.message || '';
    if (/A pull request already exists/i.test(first)) {
      return toolError(`Já existe um Pull Request aberto de "${head}" para "${base}" neste repositório.`);
    }
    if (/No commits between/i.test(first)) {
      return toolError(`O GitHub não vê diferenças entre "${base}" e "${head}". Confirme que o github_push foi feito para a branch "${head}".`);
    }
    return toolError(friendlyGithubError(r.status, r.data) + (first ? ` ${first}` : ''));
  }
  return { ok: true, url: r.data.html_url, number: r.data.number, head, base };
}

// Ponto único de entrada usado pelo runTool (tools.js).
export async function runGithubTool(name, args = {}, { userId, conversationId, signal } = {}) {
  const conn = await getGithubConnection(userId);
  if (!conn) return toolError(NOT_CONNECTED);
  try {
    if (name === 'github_list_repos') {
      const r = await listGithubRepos(conn.token, { signal });
      if (r.error) return toolError(r.error);
      return { account: conn.login, repos: r.repos.slice(0, 60) };
    }
    if (name === 'github_clone') return await githubClone(conn, conversationId, args, signal);
    if (name === 'github_push') return await githubPush(conn, conversationId, args, signal);
    if (name === 'github_create_pr') return await githubCreatePr(conn, conversationId, args, signal);
  } catch (e) {
    return toolError(`Falha inesperada na integração com o GitHub: ${scrubSecrets(e.message, conn.token).slice(0, 300)}`);
  }
  return toolError(`Ferramenta GitHub desconhecida: ${name}`);
}
