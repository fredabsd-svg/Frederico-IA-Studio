import Docker from 'dockerode';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { nanoid } from 'nanoid';
import { db } from './db.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Pastas do computador do usuário liberadas para o assistente. Cada uma vira
// um mount em /mnt/pc/<label> dentro do sandbox (só leitura ou leitura+escrita).
// Cache em memória das pastas do PC, AGRUPADAS POR USUÁRIO. Como o pg é
// assíncrono, ler a cada chamada tornaria pcFolderMounts() async — e ele é
// usado como valor padrão de parâmetro (tools.js) e dentro de funções
// síncronas (agent.js). Mantemos um cache carregado no boot (loadPcFolders) e
// atualizado sempre que as pastas mudam (via destroyAllSandboxes, chamado
// pelas rotas de pastas do PC).
// SEGURANÇA (multi-tenant): as pastas são separadas por usuário. Sem um userId,
// NENHUMA pasta é montada — um usuário nunca enxerga as pastas de outro.
let pcFoldersByUser = new Map(); // userId -> rows[]

export async function loadPcFolders() {
  const map = new Map();
  // Desligado (padrão numa VPS pública): nunca monta pastas do host, mesmo que
  // existam linhas antigas na tabela.
  if (process.env.ENABLE_PC_FOLDERS !== 'true') { pcFoldersByUser = map; return map; }
  try {
    const rows = await db.prepare('SELECT * FROM pc_folders ORDER BY created_at ASC').all();
    for (const r of rows) {
      const uid = String(r.user_id || '');
      if (!uid) continue; // pastas órfãs (sem dono) não são montadas em ninguém
      if (!map.has(uid)) map.set(uid, []);
      map.get(uid).push(r);
    }
  } catch {}
  pcFoldersByUser = map;
  return pcFoldersByUser;
}

export function pcFolderMounts(userId) {
  const rows = (userId && pcFoldersByUser.get(String(userId))) || [];
  const used = new Set();
  return rows.map(r => {
    let label = String(r.label || 'pasta').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_-]/g, '_').slice(0, 30) || 'pasta';
    while (used.has(label)) label = `${label}_`;
    used.add(label);
    return { id: r.id, source: r.host_path, target: `/mnt/pc/${label}`, writable: !!r.writable, label: r.label };
  });
}

// Descarta todos os sandboxes ativos (usado quando as pastas do PC mudam,
// para que os novos mounts entrem em vigor na próxima execução).
export async function destroyAllSandboxes() {
  for (const [id, entry] of sessions) {
    sessions.delete(id);
    try { await entry.container.remove({ force: true }); } catch {}
  }
  // As pastas do PC podem ter mudado; atualiza o cache para os novos mounts
  // entrarem em vigor na próxima execução.
  await loadPcFolders();
}
const root = path.resolve(process.env.WORKSPACE_ROOT || './workspaces');
// Caminho no HOST correspondente a `root`. Binds do Docker são interpretados
// pelo daemon como caminhos do host — quando o backend roda em container,
// os dois caminhos diferem. Sem isso, o sandbox monta um diretório vazio.
const hostRoot = process.env.HOST_WORKSPACE_ROOT || root;
const image = process.env.SANDBOX_IMAGE || 'frederico-ai-sandbox:latest';
const memory = process.env.SANDBOX_MEMORY || '1024m';
const cpus = Number(process.env.SANDBOX_CPUS || 1);
// Limite de sandboxes ATIVOS por usuário (proteção de recursos numa SaaS):
// ao criar o (N+1)-ésimo, o mais antigo do mesmo usuário é descartado.
const MAX_SANDBOXES_PER_USER = Math.max(1, Number(process.env.MAX_SANDBOXES_PER_USER || 2));

fs.mkdirSync(root, { recursive: true });
const sessions = new Map(); // id -> { container, lastUsed, policyKey, userId }

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

export function isConversationId(value) {
  return CONVERSATION_ID_RE.test(String(value || ''));
}

export function assertConversationId(value) {
  const id = String(value || '');
  if (!isConversationId(id)) {
    const error = new Error('Identificador de conversa invalido.');
    error.code = 'INVALID_CONVERSATION_ID';
    throw error;
  }
  return id;
}

// Remove containers ociosos (sem exec há 30 min) para não acumular
const IDLE_TTL_MS = Number(process.env.SANDBOX_IDLE_TTL_MS || 30 * 60 * 1000);
setInterval(async () => {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [id, entry] of sessions) {
    if (entry.lastUsed < cutoff) {
      sessions.delete(id);
      try { await entry.container.remove({ force: true }); } catch {}
    }
  }
}, 60 * 1000).unref();

export function workspaceFor(id) {
  const conversationId = assertConversationId(id);
  const base = path.join(root, conversationId);
  const uploads = path.join(base, 'uploads');
  const outputs = path.join(base, 'outputs');
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(outputs, { recursive: true });
  // O exec no sandbox roda como uid 1000 ('sandbox'); o backend cria os
  // diretórios como root. Sem chown, todo write em /workspace falha.
  for (const dir of [base, uploads, outputs]) {
    try { fs.chownSync(dir, 1000, 1000); }
    catch { try { fs.chmodSync(dir, 0o777); } catch {} }
  }
  return { base, uploads, outputs };
}

async function imageExists() {
  try { await docker.getImage(image).inspect(); return true; } catch { return false; }
}

export async function ensureSandboxImage() {
  if (!(await imageExists())) {
    throw new Error(`Imagem ${image} não encontrada. Rode: docker build -t ${image} ./sandbox`);
  }
}

// Criações em andamento (single-flight): evita que duas execuções simultâneas
// da mesma conversa criem dois containers, deixando um órfão para sempre.
const creating = new Map();

function sandboxPolicy(options = {}) {
  const readOnlyPc = !!options.readOnlyPc;
  const writablePcFolderId = readOnlyPc || !options.writablePcFolderId ? null : String(options.writablePcFolderId);
  return {
    readOnlyPc,
    writablePcFolderId,
    key: readOnlyPc ? 'read-only' : (writablePcFolderId ? `write:${writablePcFolderId}` : 'default')
  };
}

async function dropSession(conversationId) {
  const entry = sessions.get(conversationId);
  if (!entry) return;
  sessions.delete(conversationId);
  try { await entry.container.remove({ force: true }); } catch {}
}

export async function getContainer(conversationId, options = {}) {
  conversationId = assertConversationId(conversationId);
  const userId = options.userId ? String(options.userId) : null;
  const policy = sandboxPolicy(options);
  const entry = sessions.get(conversationId);
  if (entry?.policyKey === policy.key) { entry.lastUsed = Date.now(); return entry.container; }
  if (entry) await dropSession(conversationId);
  const creatingKey = `${conversationId}:${policy.key}`;
  if (creating.has(creatingKey)) return creating.get(creatingKey);
  const p = createContainer(conversationId, policy, userId);
  creating.set(creatingKey, p);
  try { return await p; }
  finally { creating.delete(creatingKey); }
}

// Mantém no máximo MAX_SANDBOXES_PER_USER sandboxes ativos por usuário:
// descarta os mais antigos (LRU) antes de abrir um novo.
async function enforceUserSandboxCap(userId) {
  if (!userId) return;
  const mine = [...sessions.entries()].filter(([, e]) => e.userId === userId);
  if (mine.length < MAX_SANDBOXES_PER_USER) return;
  mine.sort((a, b) => a[1].lastUsed - b[1].lastUsed); // mais antigo primeiro
  const excess = mine.length - MAX_SANDBOXES_PER_USER + 1; // abrir espaço para o novo
  for (let i = 0; i < excess; i++) {
    const [id] = mine[i];
    await dropSession(id);
  }
}

async function createContainer(conversationId, policy, userId = null) {
  await ensureSandboxImage();
  await enforceUserSandboxCap(userId);
  const { base } = workspaceFor(conversationId);
  const hostBase = path.join(hostRoot, conversationId);
  const name = `frederico-ai-${conversationId}-${nanoid(5)}`;
  // Pastas do PC do usuário viram mounts /mnt/pc/<label> (Mounts evita o
  // problema de parsing de caminhos do Windows com ":" no formato de Bind).
  // pcFolderMounts(userId): só as pastas DESTE usuário (isolamento multi-tenant).
  const mounts = pcFolderMounts(userId).map(m => ({
    Type: 'bind',
    Source: m.source,
    Target: m.target,
    ReadOnly: policy.readOnlyPc || !m.writable || (policy.writablePcFolderId !== null && m.id !== policy.writablePcFolderId)
  }));
  const container = await docker.createContainer({
    Image: image,
    name,
    WorkingDir: '/workspace',
    Cmd: ['sleep', 'infinity'],
    Tty: false,
    OpenStdin: false,
    // Rede LIGADA por opção do usuário: o sandbox tem acesso à internet.
    // ATENÇÃO: isto reduz o isolamento — código gerado pela IA (ou injetado
    // por um documento malicioso) passa a poder acessar a rede e, em tese,
    // exfiltrar dados/arquivos montados. Demais proteções seguem ativas
    // (CapDrop ALL, no-new-privileges, uid 1000, limites de CPU/RAM/PIDs).
    NetworkDisabled: false,
    HostConfig: {
      Binds: [`${hostBase}:/workspace`],
      Mounts: mounts,
      Memory: parseMemory(memory),
      NanoCpus: Math.floor(cpus * 1e9),
      PidsLimit: 256,
      ReadonlyRootfs: false,
      AutoRemove: true,
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL']
    }
  });
  await container.start();
  sessions.set(conversationId, { container, lastUsed: Date.now(), policyKey: policy.key, userId });
  return container;
}

function parseMemory(value) {
  const m = String(value).match(/^(\d+)(m|g)?$/i);
  if (!m) return 1024 * 1024 * 1024;
  const n = Number(m[1]);
  return (m[2] || '').toLowerCase() === 'g' ? n * 1024 ** 3 : n * 1024 ** 2;
}

const MAX_OUTPUT_BYTES = Number(process.env.SANDBOX_MAX_OUTPUT_BYTES || 8 * 1024 * 1024);

export async function execInSandbox(conversationId, cmd, timeoutMs = Number(process.env.TOOL_TIMEOUT_MS || 45000), options = {}) {
  conversationId = assertConversationId(conversationId);
  const { signal, ...sandboxOptions } = options || {};
  const canceledResult = () => ({ exitCode: 130, output: '[INTERROMPIDO: comando cancelado pelo usuario]' });
  if (signal?.aborted) return canceledResult();
  let container = await getContainer(conversationId, sandboxOptions);
  if (signal?.aborted) {
    sessions.delete(conversationId);
    void container.kill().catch(() => {});
    return canceledResult();
  }
  const makeExec = (c) => c.exec({ Cmd: ['bash', '-lc', cmd], AttachStdout: true, AttachStderr: true, WorkingDir: '/workspace', User: 'sandbox' });
  let exec;
  try {
    exec = await makeExec(container);
  } catch {
    // Container morreu (ex.: kill por timeout anterior + AutoRemove).
    // Remove a referência morta e recria uma vez.
    sessions.delete(conversationId);
    container = await getContainer(conversationId, sandboxOptions);
    exec = await makeExec(container);
  }
  let interrupted = false;
  let finishExecution = null;
  const interrupt = () => {
    interrupted = true;
    sessions.delete(conversationId);
    void container.kill().catch(() => {});
    void finishExecution?.();
  };
  if (signal?.aborted) interrupt();
  else signal?.addEventListener('abort', interrupt, { once: true });
  if (interrupted) {
    signal?.removeEventListener('abort', interrupt);
    return canceledResult();
  }
  let stream;
  try {
    stream = await exec.start({ hijack: true, stdin: false });
  } catch (err) {
    signal?.removeEventListener('abort', interrupt);
    if (interrupted || signal?.aborted) return canceledResult();
    throw err;
  }
  let output = '';
  let bytes = 0;
  let timedOut = false, tooBig = false, settled = false;
  // Desmultiplexa o protocolo de frames do Docker (Tty:false) em stdout/stderr,
  // em vez de tentar remover os cabeçalhos "na mão" (que corrompia a saída).
  const stdout = new PassThrough(), stderr = new PassThrough();
  try { container.modem.demuxStream(stream, stdout, stderr); } catch {}
  const onData = (chunk) => {
    bytes += chunk.length;
    if (!tooBig) output += chunk.toString('utf8');
    // Limita a saída acumulada no BACKEND (o limite de memória é do container,
    // não do Node): evita OOM com `yes`/prints gigantes.
    if (bytes > MAX_OUTPUT_BYTES && !tooBig) {
      tooBig = true;
      sessions.delete(conversationId);
      void container.kill().catch(() => {});
    }
  };
  stdout.on('data', onData);
  stderr.on('data', onData);
  const timer = setTimeout(() => {
    timedOut = true;
    sessions.delete(conversationId); // referência ficaria morta após o kill
    void container.kill().catch(() => {});
  }, timeoutMs);
  return await new Promise((resolve) => {
    const finish = async () => {
      if (settled) return; // 'end', 'close' e 'error' podem disparar juntos
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
      const info = await exec.inspect().catch(() => ({ ExitCode: -1 }));
      let clean = output.replace(/[\x00-\x08\x0E-\x1F]/g, '');
      if (timedOut) clean += `\n[TIMEOUT: comando excedeu ${timeoutMs / 1000}s — sandbox reiniciado]`;
      if (tooBig) clean += `\n[SAÍDA MUITO GRANDE: cortada e execução interrompida]`;
      if (interrupted) clean += '\n[INTERROMPIDO: comando cancelado pelo usuario]';
      resolve({ exitCode: interrupted ? 130 : (timedOut ? 124 : (tooBig ? 137 : info.ExitCode)), output: clean.slice(-12000) });
    };
    finishExecution = finish;
    if (interrupted) { void finish(); return; }
    // 'error' evita crash do processo se o container for removido no meio do exec
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

// Remove o sandbox e o diretório de workspace de uma conversa (usado ao apagar)
export async function destroyConversation(conversationId) {
  conversationId = assertConversationId(conversationId);
  const entry = sessions.get(conversationId);
  if (entry) {
    sessions.delete(conversationId);
    try { await entry.container.remove({ force: true }); } catch {}
  }
  try { fs.rmSync(path.join(root, conversationId), { recursive: true, force: true }); } catch {}
}

// Verifica se `target` está DENTRO de `base` (comparação com separador,
// para "/ws/abc" não autorizar "/ws/abc-outro").
export function insideBase(base, target) {
  const b = path.resolve(base);
  return target === b || target.startsWith(b + path.sep);
}

// Resolve symlinks do ancestral existente mais próximo e confirma que o
// caminho REAL continua dentro da base. Bloqueia fuga do tipo:
//   ln -s / /workspace/root  →  read_file("root/etc/passwd")
export function realInside(base, full) {
  let realBase;
  try { realBase = fs.realpathSync(base); } catch { realBase = path.resolve(base); }
  let dir = full, tail = '';
  // sobe até achar um diretório que exista, guardando a parte inexistente
  while (true) {
    try { const real = path.resolve(fs.realpathSync(dir), tail); return insideBase(realBase, real); }
    catch {
      const parent = path.dirname(dir);
      if (parent === dir) return insideBase(realBase, full); // nada existe: usa o resolvido
      tail = tail ? path.join(path.basename(dir), tail) : path.basename(dir);
      dir = parent;
    }
  }
}

export function safeJoin(base, userPath) {
  const clean = String(userPath || '').replace(/^\/+/, '');
  const full = path.resolve(base, clean);
  if (!insideBase(base, full)) throw new Error('Caminho bloqueado por segurança.');
  if (!realInside(base, full)) throw new Error('Caminho bloqueado por segurança (link).');
  return full;
}
