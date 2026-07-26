import Docker from 'dockerode';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { nanoid } from 'nanoid';
import { db } from './db.js';
import { healthMetrics } from './healthMetrics.js';
import {
  EXEC_STATUS,
  TERMINATION_REASONS,
  classifyExecOutcome,
  fingerprintWorkspace,
  fingerprintChanged,
  noteSandboxCreated,
  noteSandboxTerminated,
  takeRestartNotice,
  peekSandboxLifecycle,
  recordRuntimeInstall,
  listRuntimeInstalls,
  clearRuntimeInstalls,
  directoryUsage,
  environmentManifest,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint
} from './agentEnv.js';

// Conexão com o Docker. Em produção o backend NÃO enxerga /var/run/docker.sock:
// ele fala com o GUARDA (docker-guard), que detém o socket e valida cada
// requisição — allowlist de rotas, inspeção do corpo de /containers/create e
// posse por label. Ver docs/SECURITY.md §4 (achado F-04).
//
// O dockerode fala o mesmo protocolo por TCP ou por socket, então basta apontar
// DOCKER_HOST=tcp://docker-guard:2375; nada muda no restante deste arquivo.
function createDockerClient() {
  const host = String(process.env.DOCKER_HOST || '').trim();
  if (host) {
    try {
      const url = new URL(host.replace(/^tcp:/, 'http:'));
      return new Docker({ host: url.hostname, port: Number(url.port || 2375), protocol: 'http' });
    } catch {
      console.error(`[sandbox] DOCKER_HOST inválido (${host}); usando o socket local.`);
    }
  }
  const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
  // Aviso alto: sem o guarda, uma RCE no backend vira comprometimento do host.
  if (process.env.NODE_ENV === 'production') {
    console.warn(`[sandbox] ATENÇÃO: falando direto com ${socketPath}. Em produção, use o serviço docker-guard (DOCKER_HOST=tcp://docker-guard:2375) — ver docs/SECURITY.md §4.`);
  }
  return new Docker({ socketPath });
}

let docker = createDockerClient();
// Só para testes: injeta um cliente Docker falso (o node:test não tem daemon).
export function _setDockerClient(client) { docker = client; }

// Exposto no /api/health: o operador precisa enxergar se o guarda está no
// caminho ou se o backend está com o socket na mão.
export function dockerAccessMode() {
  return String(process.env.DOCKER_HOST || '').trim()
    ? { modo: 'guarda', destino: process.env.DOCKER_HOST }
    : { modo: 'socket-direto', destino: process.env.DOCKER_SOCKET || '/var/run/docker.sock' };
}

// ---- Identidade dos containers do Frederico (labels) ------------------------
// Todo sandbox criado por este backend leva estas labels. Elas são a base da
// RECONCILIAÇÃO no boot e da coleta periódica de órfãos: sem label, não há como
// distinguir um container nosso de um container qualquer do host — e apagar
// container de terceiro seria destrutivo.
export const SANDBOX_LABEL_APP = 'com.frederico.app';
export const SANDBOX_LABEL_USER = 'com.frederico.user';
export const SANDBOX_LABEL_CONVERSATION = 'com.frederico.conversation';
export const SANDBOX_LABEL_INSTANCE = 'com.frederico.instance';
export const SANDBOX_LABEL_VERSION = 'com.frederico.manager-version';
export const SANDBOX_APP_VALUE = 'frederico-ai-studio';
export const SANDBOX_MANAGER_VERSION = '2';
// Identidade DESTE processo. Um container com outra instância é, por definição,
// de um backend que já morreu (o app roda em processo único — ver liveStream.js).
export const SANDBOX_INSTANCE_ID = process.env.SANDBOX_INSTANCE_ID || nanoid(12);

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
    let label = String(r.label || 'pasta').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]/g, '_').slice(0, 30) || 'pasta';
    while (used.has(label)) label = `${label}_`;
    used.add(label);
    return { id: r.id, source: r.host_path, target: `/mnt/pc/${label}`, writable: !!r.writable, label: r.label };
  });
}

// Descarta os sandboxes ativos DE UM USUÁRIO (usado quando as pastas do PC
// dele mudam, para que os novos mounts entrem em vigor na próxima execução).
//
// SEGURANÇA/DISPONIBILIDADE (multi-tenant): a versão antiga (destroyAllSandboxes)
// derrubava os containers de TODOS os usuários sempre que UM mexia nas próprias
// pastas — matando execuções e tarefas em andamento de terceiros. A invalidação
// agora é direcionada: os sandboxes dos outros usuários seguem intactos.
export async function destroySandboxesForUser(userId) {
  const scope = String(userId || '');
  let destroyed = 0;
  for (const [key, entry] of [...sessions]) {
    if (String(entry.userId || '') !== scope) continue;
    sessions.delete(key);
    noteSandboxTerminated(key, TERMINATION_REASONS.PC_FOLDERS);
    try { await entry.container.remove({ force: true }); destroyed++; } catch {}
  }
  // As pastas do PC podem ter mudado; atualiza o cache para os novos mounts
  // entrarem em vigor na próxima execução.
  await loadPcFolders();
  return destroyed;
}

// Descarta TODOS os sandboxes. Continua existindo para desligamento
// ordenado/manutenção e testes — NÃO deve ser chamado por uma ação de usuário
// comum (ver destroySandboxesForUser).
export async function destroyAllSandboxes() {
  for (const [id, entry] of [...sessions]) {
    sessions.delete(id);
    noteSandboxTerminated(id, TERMINATION_REASONS.SHUTDOWN);
    try { await entry.container.remove({ force: true }); } catch {}
  }
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
// Chave: `${userDirName}/${conversationId}` (NUNCA só a conversa) — ver
// sessionKey(). Valor: { container, containerId, lastUsed, policyKey, userId }.
const sessions = new Map();
// Só para testes de isolamento (dois usuários com sandbox simultâneo).
export const _sessionsForTests = sessions;

// ---- Escopo físico do workspace: WORKSPACE_ROOT/users/<userDir>/<conversa> --
// Antes o workspace era WORKSPACE_ROOT/<conversationId>: a chave física NÃO
// tinha dono, então qualquer defesa contra acesso cruzado dependia unicamente
// de a checagem de posse no banco nunca falhar e de os ids de conversa jamais
// colidirem. Agora o dono faz parte do CAMINHO — defesa em profundidade: mesmo
// que uma rota esqueça o WHERE user_id, o arquivo de outro usuário está em
// outra árvore de diretórios.
//
// O nível intermediário fixo "users" impede colisão com os diretórios legados
// (um id de conversa tem no mínimo 6 caracteres — ver CONVERSATION_ID_RE —,
// então nenhuma conversa pode se chamar "users").
export const WORKSPACE_USERS_DIR = 'users';

// Nome de diretório para um userId. INJETIVO: ids que já são seguros viram eles
// mesmos; qualquer outro vira um hash (nunca uma substituição "com colisão",
// que faria dois usuários compartilharem a mesma pasta).
export function userDirName(userId) {
  const raw = String(userId ?? '').trim();
  if (!raw) {
    const error = new Error('Escopo de usuário obrigatório para acessar o workspace.');
    error.code = 'WORKSPACE_SCOPE_REQUIRED';
    throw error;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)) return raw;
  return `h_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
}

// Chave do mapa de sandboxes: usuário + conversa. Duas conversas de donos
// diferentes nunca compartilham entrada, mesmo com o mesmo id de conversa.
export function sessionKey(userId, conversationId) {
  return `${userDirName(userId)}/${assertConversationId(conversationId)}`;
}

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
  for (const [id, entry] of [...sessions]) {
    if (entry.lastUsed < cutoff) {
      sessions.delete(id);
      noteSandboxTerminated(id, TERMINATION_REASONS.IDLE);
      try { await entry.container.remove({ force: true }); } catch {}
    }
  }
  healthMetrics.sandboxesActive = sessions.size;
}, 60 * 1000).unref();

// Coletor de lixo de DISCO (o reaper acima só recicla CONTAINERS). Num soak
// (loop gerando arquivos por horas) o disco crescia sem limite: scripts .tmp_*
// órfãos e a pasta outputs acumulando. Aqui:
//  - removemos scripts .tmp_*.py com mais de 2h (um run tem timeout de ~1min,
//    então esses são certamente abandonados por uma queda de processo);
//  - se OUTPUT_RETENTION_DAYS > 0, removemos arquivos de outputs mais antigos
//    que isso (desligado por padrão — apagar entregas do usuário é decisão do
//    operador; ligue num ambiente público/de carga).
const TMP_SCRIPT_TTL_MS = 2 * 60 * 60 * 1000;
const OUTPUT_RETENTION_DAYS = Math.max(0, Number(process.env.OUTPUT_RETENTION_DAYS || 0));
const DISK_SWEEP_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.DISK_SWEEP_INTERVAL_MS || 30 * 60 * 1000));
// Todas as bases de conversa em disco: as novas (root/users/<user>/<conversa>)
// e as legadas ainda não migradas (root/<conversa>).
function allConversationBases() {
  const bases = [];
  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return bases; }
  for (const entry of top) {
    if (entry.name === WORKSPACE_USERS_DIR) {
      const usersRoot = path.join(root, WORKSPACE_USERS_DIR);
      let users = [];
      try { users = fs.readdirSync(usersRoot, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
      for (const user of users) {
        const userRoot = path.join(usersRoot, user.name);
        try {
          for (const conv of fs.readdirSync(userRoot, { withFileTypes: true })) {
            // `.cache` do usuário não é conversa: a varredura de disco não deve
            // aparar arquivos lá dentro (é justamente o que faz a reinstalação
            // de dependências ser barata depois de um reinício).
            if (conv.isDirectory() && !conv.name.startsWith('.')) bases.push(path.join(userRoot, conv.name));
          }
        } catch {}
      }
      continue;
    }
    if (entry.name.startsWith('.')) continue; // `.checkpoints` e afins
    bases.push(path.join(root, entry.name)); // legado (pré-migração)
  }
  return bases;
}

function reapDisk() {
  const nowMs = Date.now();
  for (const convBase of allConversationBases()) {
    // 1) scripts temporários órfãos direto na base da conversa
    try {
      for (const name of fs.readdirSync(convBase)) {
        if (!/^\.tmp_.*\.py$/.test(name)) continue;
        const full = path.join(convBase, name);
        try { if (nowMs - fs.statSync(full).mtimeMs > TMP_SCRIPT_TTL_MS) fs.rmSync(full, { force: true }); } catch {}
      }
    } catch {}
    // 2) retenção opcional dos arquivos de saída
    if (OUTPUT_RETENTION_DAYS > 0) {
      const cutoff = nowMs - OUTPUT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const outDir = path.join(convBase, 'outputs');
      const sweep = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { sweep(full); continue; }
          try { if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true }); } catch {}
        }
      };
      sweep(outDir);
    }
  }
}
setInterval(reapDisk, DISK_SWEEP_INTERVAL_MS).unref();

// Migração preguiçosa dos workspaces legados (root/<conversa>) para o layout
// com dono (root/users/<userDir>/<conversa>). Executada na PRIMEIRA vez que a
// conversa é acessada depois da atualização; a migração em lote no boot
// (migrateLegacyWorkspaces) cuida das conversas que ninguém abrir.
// Nunca sobrescreve um destino já existente — em caso de conflito, o legado é
// preservado no lugar (nada é apagado) e o incidente é registrado.
function migrateLegacyWorkspace(conversationId, base) {
  const legacy = path.join(root, conversationId);
  if (base === legacy) return false;
  let legacyIsDir = false;
  try { legacyIsDir = fs.statSync(legacy).isDirectory(); } catch { return false; }
  if (!legacyIsDir) return false;
  if (fs.existsSync(base)) {
    console.warn(`[workspace] conflito ao migrar ${conversationId}: destino já existe; o diretório legado foi mantido em ${legacy}.`);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.renameSync(legacy, base);
    console.log(`[workspace] migrado ${conversationId} para o layout por usuário.`);
    return true;
  } catch (e) {
    console.error(`[workspace] falha ao migrar ${conversationId}: ${e.message}`);
    return false;
  }
}

// Migração em lote no boot: move os workspaces legados para o diretório do
// respectivo dono, consultando a tabela de conversas. Idempotente e tolerante a
// falhas (um diretório problemático não impede os demais).
export async function migrateLegacyWorkspaces() {
  let legacyDirs = [];
  try {
    legacyDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== WORKSPACE_USERS_DIR && isConversationId(d.name))
      .map(d => d.name);
  } catch { return { migrated: 0, orphans: 0 }; }
  if (!legacyDirs.length) return { migrated: 0, orphans: 0 };
  let migrated = 0, orphans = 0;
  for (const conversationId of legacyDirs) {
    let owner = null;
    try { owner = await db.prepare('SELECT user_id FROM conversations WHERE id=?').get(conversationId); } catch { break; }
    if (!owner?.user_id) { orphans++; continue; } // sem dono conhecido: NÃO adivinha, deixa onde está
    try {
      if (migrateLegacyWorkspace(conversationId, path.join(root, WORKSPACE_USERS_DIR, userDirName(owner.user_id), conversationId))) migrated++;
    } catch {}
  }
  if (migrated || orphans) {
    console.log(`[workspace] migração de layout: ${migrated} movido(s), ${orphans} sem dono no banco (mantido(s) no lugar).`);
  }
  return { migrated, orphans };
}

// Caminho do workspace da conversa, SEMPRE escopado pelo dono. O `userId` é
// obrigatório: sem ele lança WORKSPACE_SCOPE_REQUIRED, para que um chamador
// esquecido apareça no teste em vez de gravar num caminho sem dono.
export function workspaceFor(id, userId) {
  const conversationId = assertConversationId(id);
  const base = path.join(root, WORKSPACE_USERS_DIR, userDirName(userId), conversationId);
  migrateLegacyWorkspace(conversationId, base);
  const uploads = path.join(base, 'uploads');
  const outputs = path.join(base, 'outputs');
  // Camadas do plano de estabilização, ambas PERSISTENTES (estão dentro do
  // workspace, que é bind do host): `.artifacts` guarda relatórios/patches que
  // não são entrega ao usuário (outputs vira cartão de download; isto não), e
  // `.agent-env` guarda os metadados da sessão — hoje, o manifesto das
  // dependências instaladas em runtime.
  const artifacts = path.join(base, '.artifacts');
  const agentEnv = path.join(base, '.agent-env');
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(outputs, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(agentEnv, { recursive: true });
  // O exec no sandbox roda como uid 1000 ('sandbox'); o backend cria os
  // diretórios como root. Sem chown, todo write em /workspace falha.
  for (const dir of [base, uploads, outputs, artifacts, agentEnv]) {
    try { fs.chownSync(dir, 1000, 1000); }
    catch { try { fs.chmodSync(dir, 0o777); } catch {} }
  }
  return { base, uploads, outputs, artifacts, agentEnv };
}

// Cache de pacotes do USUÁRIO (pip/npm), compartilhado entre as conversas dele
// e montado em /cache. É o que faz `pip install` sobreviver à morte do
// container: o pacote não fica só na camada temporária da imagem — o wheel
// baixado continua no host e a reinstalação é local e instantânea.
// Fica ao lado dos diretórios de conversa; um id de conversa nunca começa com
// ponto (CONVERSATION_ID_RE), então não há colisão possível.
export const USER_CACHE_DIR = '.cache';

export function userCacheDir(userId) {
  const dir = path.join(root, WORKSPACE_USERS_DIR, userDirName(userId), USER_CACHE_DIR);
  for (const sub of ['pip', 'npm', 'uv', 'poetry', 'yarn', 'pnpm']) {
    try { fs.mkdirSync(path.join(dir, sub), { recursive: true }); } catch {}
  }
  try { fs.chownSync(dir, 1000, 1000); } catch { try { fs.chmodSync(dir, 0o777); } catch {} }
  for (const sub of ['pip', 'npm', 'uv', 'poetry', 'yarn', 'pnpm']) {
    try { fs.chownSync(path.join(dir, sub), 1000, 1000); } catch {}
  }
  return dir;
}

// Checkpoints ficam FORA da árvore da conversa: se morassem dentro, o snapshot
// seguinte copiaria o anterior (crescimento quadrático) e o próprio sandbox
// poderia apagá-los. `.checkpoints` não é um id de conversa válido, então a
// varredura de workspaces legados o ignora.
export const CHECKPOINTS_DIR = '.checkpoints';

export function checkpointsDirFor(userId, conversationId) {
  const dir = path.join(root, CHECKPOINTS_DIR, userDirName(userId), assertConversationId(conversationId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

export function sandboxPolicy(options = {}) {
  const readOnlyPc = !!options.readOnlyPc;
  const writablePcFolderId = readOnlyPc || !options.writablePcFolderId ? null : String(options.writablePcFolderId);
  const networkEnabled = options.networkEnabled === true;
  const accessKey = readOnlyPc ? 'read-only' : (writablePcFolderId ? `write:${writablePcFolderId}` : 'default');
  return {
    readOnlyPc,
    writablePcFolderId,
    networkEnabled,
    key: `${accessKey}|network:${networkEnabled ? 'on' : 'off'}`
  };
}

async function dropSession(key, reason = TERMINATION_REASONS.POLICY) {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  noteSandboxTerminated(key, reason);
  try { await entry.container.remove({ force: true }); } catch {}
}

export async function getContainer(conversationId, options = {}) {
  conversationId = assertConversationId(conversationId);
  const userId = requireUserScope(options.userId);
  const key = sessionKey(userId, conversationId);
  const policy = sandboxPolicy(options);
  const entry = sessions.get(key);
  if (entry?.policyKey === policy.key) { entry.lastUsed = Date.now(); return entry.container; }
  if (entry) await dropSession(key);
  // Single-flight POR (USUÁRIO, CONVERSA) — não por política: uma conversa tem
  // no máximo UM container. A chave antiga incluía a política, então duas
  // chamadas concorrentes na MESMA conversa com políticas diferentes (ex.:
  // read-only x default) não se viam, criavam DOIS containers e `sessions.set`
  // sobrescrevia o primeiro — que ficava rodando (`sleep infinity`) fora do
  // mapa, sem ser reciclado pelo reaper nem por destroyConversation.
  // Serializando por conversa, a segunda chamada espera a primeira e então
  // reavalia: se a política bater, reusa o container; se não, dropSession
  // remove o anterior de forma limpa.
  if (creating.has(key)) {
    await creating.get(key).catch(() => {});
    return getContainer(conversationId, options);
  }
  const p = createContainer(conversationId, policy, userId);
  creating.set(key, p);
  try { return await p; }
  finally { creating.delete(key); }
}

// O escopo de usuário é obrigatório em toda operação de sandbox: um container
// sem dono não pode ser contabilizado no teto por usuário, nem invalidado
// seletivamente, nem reconciliado por label.
function requireUserScope(userId) {
  const raw = userId == null ? '' : String(userId).trim();
  if (!raw) {
    const error = new Error('Escopo de usuário obrigatório para operar o sandbox.');
    error.code = 'WORKSPACE_SCOPE_REQUIRED';
    throw error;
  }
  return raw;
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
    await dropSession(id, TERMINATION_REASONS.USER_CAP);
  }
}

async function createContainer(conversationId, policy, userId) {
  await ensureSandboxImage();
  await enforceUserSandboxCap(userId);
  workspaceFor(conversationId, userId); // cria/migra a árvore antes do bind
  const scope = userDirName(userId);
  // O bind é interpretado pelo DAEMON, então usa o caminho do HOST — que precisa
  // espelhar exatamente o layout escopado por usuário criado acima.
  const hostBase = path.join(hostRoot, WORKSPACE_USERS_DIR, scope, conversationId);
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
  // Cache de pacotes do usuário em /cache: fica no HOST, então um `pip install`
  // feito nesta conversa continua valendo depois de o container morrer — e
  // vale também para as outras conversas do MESMO usuário (nunca de outro:
  // o caminho é escopado por userDirName, como o workspace).
  userCacheDir(userId);
  const hostCache = path.join(hostRoot, WORKSPACE_USERS_DIR, scope, USER_CACHE_DIR);
  const container = await docker.createContainer({
    Image: image,
    name,
    WorkingDir: '/workspace',
    Cmd: ['sleep', 'infinity'],
    Tty: false,
    OpenStdin: false,
    // Identidade do container: permite reconciliar/coletar órfãos no boot sem
    // NUNCA tocar em containers que não sejam do Frederico (ver
    // selectOrphanContainers / reconcileSandboxes).
    Labels: {
      [SANDBOX_LABEL_APP]: SANDBOX_APP_VALUE,
      [SANDBOX_LABEL_USER]: userDirName(userId),
      [SANDBOX_LABEL_CONVERSATION]: conversationId,
      [SANDBOX_LABEL_INSTANCE]: SANDBOX_INSTANCE_ID,
      [SANDBOX_LABEL_VERSION]: SANDBOX_MANAGER_VERSION
    },
    // Rede fechada por padrão. Uma autorização explícita do pedido atual muda
    // a política e recria o container, evitando que a permissão vaze entre turnos.
    NetworkDisabled: !policy.networkEnabled,
    HostConfig: {
      Binds: [`${hostBase}:/workspace`, `${hostCache}:/cache`],
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
  const key = sessionKey(userId, conversationId);
  // Registra a GERAÇÃO do sandbox. Se já houve um container antes para esta
  // chave, isto é um reinício e um aviso estruturado fica pendente — o modelo
  // será informado do que sobreviveu e do que se perdeu (ver agentEnv.js).
  const { generation } = noteSandboxCreated(key, container.id);
  sessions.set(key, {
    container,
    containerId: container.id,
    lastUsed: Date.now(),
    policyKey: policy.key,
    userId,
    conversationId,
    generation,
    startedAt: Date.now()
  });
  healthMetrics.sandboxesActive = sessions.size;
  return container;
}

// ---- Reconciliação de containers órfãos -------------------------------------
// PURA e testável: dada a lista do Docker, decide o que remover. Um container só
// entra na lista de órfãos se:
//   1) carrega a label do Frederico (jamais tocamos em container de terceiros);
//   2) é de OUTRA instância do backend (o processo que o criou já morreu), OU
//      é desta instância mas sumiu do mapa `sessions` e já passou da carência
//      (criação abortada no meio, exceção perdida, mapa zerado).
export function selectOrphanContainers(list, { known = new Set(), instanceId, graceMs = 0, nowMs = Date.now() } = {}) {
  const orphans = [];
  for (const c of list || []) {
    const labels = c.Labels || c.labels || {};
    if (labels[SANDBOX_LABEL_APP] !== SANDBOX_APP_VALUE) continue;
    const id = c.Id || c.id;
    const fromAnotherInstance = labels[SANDBOX_LABEL_INSTANCE] !== instanceId;
    const createdMs = Number(c.Created || 0) * 1000;
    const olderThanGrace = !createdMs || (nowMs - createdMs) >= graceMs;
    if (fromAnotherInstance || (!known.has(id) && olderThanGrace)) {
      orphans.push({ id, name: (c.Names && c.Names[0]) || labels[SANDBOX_LABEL_CONVERSATION] || id, reason: fromAnotherInstance ? 'instancia-anterior' : 'fora-do-mapa' });
    }
  }
  return orphans;
}

const RECONCILE_ON_BOOT = process.env.SANDBOX_RECONCILE_ON_BOOT !== 'false';
const ORPHAN_GRACE_MS = Math.max(0, Number(process.env.SANDBOX_ORPHAN_GRACE_MS ?? 10 * 60 * 1000));
const RECONCILE_INTERVAL_MS = Math.max(0, Number(process.env.SANDBOX_RECONCILE_INTERVAL_MS ?? 15 * 60 * 1000));

// Remove os containers órfãos do Frederico. Chamada no boot (carência 0: tudo
// que sobrou de um processo anterior é lixo) e periodicamente (com carência,
// para não competir com uma criação em andamento).
export async function reconcileSandboxes({ graceMs = ORPHAN_GRACE_MS } = {}) {
  let list = [];
  try {
    list = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${SANDBOX_LABEL_APP}=${SANDBOX_APP_VALUE}`] })
    });
  } catch (e) {
    healthMetrics.sandboxReconcileError = String(e?.message || e).slice(0, 200);
    return { checked: 0, removed: 0, failed: 0, error: e?.message };
  }
  const known = new Set([...sessions.values()].map(e => e.containerId).filter(Boolean));
  const orphans = selectOrphanContainers(list, { known, instanceId: SANDBOX_INSTANCE_ID, graceMs });
  let removed = 0, failed = 0;
  for (const orphan of orphans) {
    try { await docker.getContainer(orphan.id).remove({ force: true }); removed++; }
    catch { failed++; }
  }
  healthMetrics.sandboxesActive = sessions.size;
  healthMetrics.sandboxOrphansRemoved = (healthMetrics.sandboxOrphansRemoved || 0) + removed;
  healthMetrics.sandboxLastReconcileAt = new Date().toISOString();
  healthMetrics.sandboxReconcileError = null;
  if (removed || failed) console.log(`[sandbox] reconciliação: ${removed} órfão(s) removido(s), ${failed} falha(s), ${list.length} container(es) do app inspecionado(s).`);
  return { checked: list.length, removed, failed };
}

// Arma a reconciliação: uma varredura imediata no boot (sem carência) e depois
// varreduras periódicas com carência. SANDBOX_RECONCILE_ON_BOOT=false desliga
// (necessário se um dia houver mais de uma réplica no MESMO daemon Docker).
export function startSandboxReconciliation() {
  if (!RECONCILE_ON_BOOT) {
    console.warn('[sandbox] reconciliação desligada (SANDBOX_RECONCILE_ON_BOOT=false): containers órfãos precisarão de limpeza manual.');
    return;
  }
  void reconcileSandboxes({ graceMs: 0 }).catch(() => {});
  if (RECONCILE_INTERVAL_MS > 0) {
    setInterval(() => { void reconcileSandboxes().catch(() => {}); }, RECONCILE_INTERVAL_MS).unref();
  }
}

function parseMemory(value) {
  const m = String(value).match(/^(\d+)(m|g)?$/i);
  if (!m) return 1024 * 1024 * 1024;
  const n = Number(m[1]);
  return (m[2] || '').toLowerCase() === 'g' ? n * 1024 ** 3 : n * 1024 ** 2;
}

const MAX_OUTPUT_BYTES = Number(process.env.SANDBOX_MAX_OUTPUT_BYTES || 8 * 1024 * 1024);
// Carência entre matar a ÁRVORE de processos do comando e derrubar o container
// inteiro. Ver killExecTree(): derrubar o container é o último recurso.
const PROCESS_KILL_GRACE_MS = Math.max(200, Number(process.env.SANDBOX_KILL_GRACE_MS || 2500));

// Ambiente de TODA execução. As três primeiras variáveis são o que separa, na
// prática, o que sobrevive do que é descartável:
//   * TMPDIR aponta para /runtime/tmp — temporário POR DESIGN, e o agente é
//     instruído a nunca guardar ali nada que precise do comando seguinte;
//   * PIP_CACHE_DIR/npm_config_cache apontam para /cache, que é bind do host —
//     é o que faz uma reinstalação depois de um reinício ser local e barata.
function execEnvironment(execId) {
  return [
    'TMPDIR=/runtime/tmp',
    'TMP=/runtime/tmp',
    'PIP_CACHE_DIR=/cache/pip',
    'npm_config_cache=/cache/npm',
    'YARN_CACHE_FOLDER=/cache/yarn',
    'UV_CACHE_DIR=/cache/uv',
    'POETRY_CACHE_DIR=/cache/poetry',
    `FREDERICO_EXEC_ID=${execId}`
  ];
}

// Encerra o comando e TODA a descendência dele sem derrubar o container.
//
// Antes, um timeout matava o container inteiro: os processos filhos morriam
// junto (correto), mas levavam embora os pacotes instalados no turno, os
// serviços de apoio e qualquer estado fora do workspace — e o agente ficava
// sem saber. Como o `FREDERICO_EXEC_ID` é HERDADO por todo processo filho,
// varrer /proc por essa variável encontra netos e bisnetos, inclusive os que
// trocaram de nome ou de grupo de processos.
async function killExecTree(container, execId) {
  const script = [
    'for p in /proc/[0-9]*; do',
    `  grep -qz "FREDERICO_EXEC_ID=${execId}" "$p/environ" 2>/dev/null && kill -TERM "${'${p#/proc/}'}" 2>/dev/null;`,
    'done',
    'sleep 1',
    'for p in /proc/[0-9]*; do',
    `  grep -qz "FREDERICO_EXEC_ID=${execId}" "$p/environ" 2>/dev/null && kill -KILL "${'${p#/proc/}'}" 2>/dev/null;`,
    'done',
    'true'
  ].join('\n');
  const exec = await container.exec({ Cmd: ['bash', '-lc', script], AttachStdout: false, AttachStderr: false, WorkingDir: '/workspace', User: 'sandbox' });
  await exec.start({ hijack: true, stdin: false });
  return true;
}

export async function execInSandbox(conversationId, cmd, timeoutMs = Number(process.env.TOOL_TIMEOUT_MS || 45000), options = {}) {
  conversationId = assertConversationId(conversationId);
  const { signal, ...sandboxOptions } = options || {};
  // Chave composta: toda remocao/troca de sessao abaixo mira SO o sandbox
  // (usuario, conversa) deste run — nunca o de outro usuario.
  const userId = requireUserScope(sandboxOptions.userId);
  const key = sessionKey(userId, conversationId);
  const startedAt = Date.now();
  const execId = nanoid(16);
  // Impressão digital ANTES do comando: é o que permite dizer, depois de uma
  // interrupção, se ele chegou a mexer em arquivos. Sem isso o agente só pode
  // supor — e supor "não mexeu" já causou retrabalho e sobrescrita.
  let workspaceBase = null;
  let before = null;
  try {
    workspaceBase = workspaceFor(conversationId, userId).base;
    before = fingerprintWorkspace(workspaceBase);
  } catch {}
  const decorate = (result, status) => {
    const after = workspaceBase ? fingerprintWorkspace(workspaceBase) : null;
    const diagnostico = classifyExecOutcome({ exitCode: result.exitCode, output: result.output, status });
    const notice = takeRestartNotice(key);
    return {
      ...result,
      status,
      sucesso: status === EXEC_STATUS.OK && result.exitCode === 0,
      duracao_ms: Date.now() - startedAt,
      processo_encerrado: status !== EXEC_STATUS.OK,
      saida_parcial: status !== EXEC_STATUS.OK && !!result.output,
      arquivos_alterados: fingerprintChanged(before, after),
      diagnostico,
      ...(notice ? { ambiente_reiniciado: notice } : {})
    };
  };
  const canceledResult = () => decorate({ exitCode: 130, output: '[INTERROMPIDO: comando cancelado pelo usuario]' }, EXEC_STATUS.CANCELED);
  if (signal?.aborted) return canceledResult();
  let container = await getContainer(conversationId, sandboxOptions);
  if (signal?.aborted) {
    sessions.delete(key);
    noteSandboxTerminated(key, TERMINATION_REASONS.CANCELED);
    void container.kill().catch(() => {});
    return canceledResult();
  }
  const makeExec = (c) => c.exec({ Cmd: ['bash', '-lc', cmd], Env: execEnvironment(execId), AttachStdout: true, AttachStderr: true, WorkingDir: '/workspace', User: 'sandbox' });
  let exec;
  try {
    exec = await makeExec(container);
  } catch {
    // Container morreu (ex.: kill por timeout anterior + AutoRemove).
    // Remove a referência morta e recria uma vez.
    sessions.delete(key);
    container = await getContainer(conversationId, sandboxOptions);
    exec = await makeExec(container);
  }
  let interrupted = false;
  let finishExecution = null;
  let sandboxDestroyed = false;
  let timedOut = false, tooBig = false, settled = false;
  // Encerra o comando preservando o sandbox. Só derruba o container se a
  // árvore de processos não morrer dentro da carência — assim um timeout deixa
  // de custar as dependências instaladas e o estado do ambiente.
  const stopCommand = async (reason) => {
    try {
      await killExecTree(container, execId);
      await new Promise(r => setTimeout(r, PROCESS_KILL_GRACE_MS));
      if (settled) return;
    } catch {}
    sandboxDestroyed = true;
    sessions.delete(key);
    noteSandboxTerminated(key, reason);
    try { await container.kill(); } catch {}
    void finishExecution?.();
  };
  const interrupt = () => {
    interrupted = true;
    void stopCommand(TERMINATION_REASONS.CANCELED);
    // O cancelamento é do usuário e precisa responder na hora: não espera a
    // carência da árvore de processos para devolver o resultado.
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
      void stopCommand(TERMINATION_REASONS.OUTPUT_LIMIT);
    }
  };
  stdout.on('data', onData);
  stderr.on('data', onData);
  const timer = setTimeout(() => {
    timedOut = true;
    void stopCommand(TERMINATION_REASONS.TIMEOUT);
  }, timeoutMs);
  return await new Promise((resolve) => {
    const finish = async () => {
      if (settled) return; // 'end', 'close' e 'error' podem disparar juntos
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
      const info = await exec.inspect().catch(() => ({ ExitCode: -1 }));
      let clean = output.replace(/[\x00-\x08\x0E-\x1F]/g, '');
      if (timedOut) clean += `\n[TIMEOUT: comando excedeu ${timeoutMs / 1000}s e foi encerrado${sandboxDestroyed ? ' — o sandbox precisou ser reiniciado' : ' (o sandbox continua de pé)'}. A execução NÃO terminou: não trate o resultado como concluído.]`;
      if (tooBig) clean += `\n[SAÍDA MUITO GRANDE: cortada e execução interrompida]`;
      if (interrupted) clean += '\n[INTERROMPIDO: comando cancelado pelo usuario]';
      const status = interrupted ? EXEC_STATUS.CANCELED
        : timedOut ? EXEC_STATUS.TIMEOUT
        : tooBig ? EXEC_STATUS.OUTPUT_LIMIT
        : EXEC_STATUS.OK;
      const exitCode = interrupted ? 130 : (timedOut ? 124 : (tooBig ? 137 : info.ExitCode));
      // Só registra a instalação quando ela REALMENTE terminou bem: um `pip
      // install` cortado por timeout deixaria o manifesto mentindo.
      if (status === EXEC_STATUS.OK && exitCode === 0 && workspaceBase) {
        try { recordRuntimeInstall(path.join(workspaceBase, '.agent-env'), cmd); } catch {}
      }
      resolve(decorate({ exitCode, output: clean.slice(-12000) }, status));
    };
    finishExecution = finish;
    if (interrupted) { void finish(); return; }
    // 'error' evita crash do processo se o container for removido no meio do exec
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

// Executa um comando APENAS se já houver um sandbox ativo para a conversa —
// nunca cria, troca nem mata um container. É o caminho certo para OBSERVAÇÃO
// (ex.: monitoramento do Companion): o execInSandbox normal materializa um
// container novo quando não há (custo/churn na VPS) e, pior, DERRUBA e recria
// o container ativo quando a política das opções não bate com a dele (o
// monitor rodaria com política default e mataria um sandbox de modo dev no
// meio do trabalho). Aqui nada disso acontece: sem sandbox ativo devolve null;
// no timeout, apenas desiste da leitura (o container do usuário segue intacto).
// De propósito NÃO atualiza lastUsed: observar não prolonga a vida do sandbox
// (senão o polling do monitor impediria o reaper de reciclá-lo para sempre).
export async function execInActiveSandbox(userId, conversationId, cmd, timeoutMs = 20000) {
  conversationId = assertConversationId(conversationId);
  const entry = sessions.get(sessionKey(requireUserScope(userId), conversationId));
  if (!entry) return null;
  const container = entry.container;
  try {
    const exec = await container.exec({ Cmd: ['bash', '-lc', cmd], AttachStdout: true, AttachStderr: true, WorkingDir: '/workspace', User: 'sandbox' });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough(), stderr = new PassThrough();
    try { container.modem.demuxStream(stream, stdout, stderr); } catch {}
    let output = '';
    const onData = (chunk) => { if (output.length < 64_000) output += chunk.toString('utf8'); };
    stdout.on('data', onData);
    stderr.on('data', onData);
    return await new Promise((resolve) => {
      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const info = await exec.inspect().catch(() => ({ ExitCode: -1 }));
        resolve({ exitCode: info.ExitCode ?? -1, output: output.replace(/[\x00-\x08\x0E-\x1F]/g, '').slice(-12000) });
      };
      const timer = setTimeout(() => { try { stream.destroy(); } catch {} void finish(); }, timeoutMs);
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', finish);
    });
  } catch {
    return null; // container morreu entre o get e o exec: sem observação neste ciclo
  }
}

// ---- Observabilidade e continuidade do ambiente -----------------------------
// Estas funções são a face do plano de estabilização para o agente (ferramenta
// `ambiente`) e para o operador. Todas exigem escopo de usuário: um relatório
// de ambiente sem dono vazaria estado de uma conversa para outra.

// Consome o aviso de reinício pendente (se houver). Chamado pelo preâmbulo do
// turno: o modelo precisa saber do reinício ANTES de agir, não depois de uma
// falha confusa.
export function takeSandboxRestartNotice(userId, conversationId) {
  try { return takeRestartNotice(sessionKey(userId, conversationId)); }
  catch { return null; }
}

const SANDBOX_LIMITS = () => ({
  memoryMb: Math.round(parseMemory(memory) / 1024 / 1024),
  cpus,
  pids: 256,
  commandTimeoutMs: Number(process.env.TOOL_TIMEOUT_MS || 45000),
  maxOutputBytes: MAX_OUTPUT_BYTES,
  idleTtlMs: IDLE_TTL_MS,
  maxSandboxesPerUser: MAX_SANDBOXES_PER_USER
});

// Manifesto + estado: o que existe, o que é persistente, quais são os limites,
// em que geração o sandbox está e o que se perdeu no último encerramento.
export function sandboxEnvironmentStatus(userId, conversationId, { networkEnabled = false } = {}) {
  const scope = requireUserScope(userId);
  const key = sessionKey(scope, conversationId);
  const ws = workspaceFor(conversationId, scope);
  const uso = directoryUsage(ws.base);
  const ciclo = peekSandboxLifecycle(key);
  const ativo = sessions.get(key);
  return {
    ...environmentManifest({
      instanceId: SANDBOX_INSTANCE_ID,
      sessionKey: key,
      generation: ciclo.geracao,
      limits: SANDBOX_LIMITS(),
      network: networkEnabled,
      workspace: { base: '/workspace', arquivos: fingerprintWorkspace(ws.base).arquivos, bytes: uso.bytes }
    }),
    sandbox: {
      ativo: !!ativo,
      criado_em: ativo?.startedAt ? new Date(ativo.startedAt).toISOString() : null,
      ultimo_encerramento: ciclo.ultimo_encerramento
    },
    dependencias_instaladas_em_runtime: listRuntimeInstalls(ws.agentEnv).length,
    checkpoints: listCheckpoints(checkpointsDirFor(scope, conversationId)).length
  };
}

// CPU, memória, disco e processos. As métricas do container vêm do daemon
// (rota /stats, liberada no guarda); quando não há sandbox ativo, o relatório
// ainda entrega o disco — que é a parte persistente e a que costuma estourar.
export async function sandboxResources(userId, conversationId) {
  const scope = requireUserScope(userId);
  const key = sessionKey(scope, conversationId);
  const ws = workspaceFor(conversationId, scope);
  const uso = directoryUsage(ws.base);
  const quotaMb = Math.max(0, Number(process.env.WORKSPACE_QUOTA_MB || 0));
  const relatorio = {
    disco: {
      workspace_bytes: uso.bytes,
      cota_mb: quotaMb || null,
      uso_da_cota_pct: quotaMb ? Math.round((uso.bytes / (quotaMb * 1024 * 1024)) * 100) : null,
      maiores_diretorios: uso.maiores
    },
    memoria: null,
    cpu: null,
    processos: null,
    sandbox_ativo: sessions.has(key)
  };
  if (relatorio.disco.uso_da_cota_pct !== null && relatorio.disco.uso_da_cota_pct >= 85) {
    relatorio.aviso = `O workspace já usa ${relatorio.disco.uso_da_cota_pct}% da cota. Libere espaço antes de gerar mais arquivos.`;
  }
  const entry = sessions.get(key);
  if (!entry) return relatorio;
  try {
    const stats = await entry.container.stats({ stream: false });
    const mem = stats?.memory_stats || {};
    if (mem.usage) {
      relatorio.memoria = {
        usada_mb: Math.round(mem.usage / 1024 / 1024),
        limite_mb: mem.limit ? Math.round(mem.limit / 1024 / 1024) : null,
        pct: mem.limit ? Math.round((mem.usage / mem.limit) * 100) : null
      };
    }
    // O Docker entrega contadores acumulados; o percentual é a variação entre a
    // leitura atual e a anterior, normalizada pelo número de CPUs.
    const cpuDelta = (stats?.cpu_stats?.cpu_usage?.total_usage || 0) - (stats?.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta = (stats?.cpu_stats?.system_cpu_usage || 0) - (stats?.precpu_stats?.system_cpu_usage || 0);
    const online = stats?.cpu_stats?.online_cpus || cpus;
    if (cpuDelta > 0 && sysDelta > 0) relatorio.cpu = { pct: Math.round((cpuDelta / sysDelta) * online * 100) };
  } catch (e) {
    relatorio.metricas_indisponiveis = String(e?.message || e).slice(0, 160);
  }
  const ps = await execInActiveSandbox(scope, conversationId, 'ps -eo pid,rss,comm --sort=-rss | head -n 8', 10000).catch(() => null);
  if (ps?.output) relatorio.processos = ps.output.trim().slice(0, 1200);
  return relatorio;
}

// Checkpoints: cópia integral do workspace fora da árvore da conversa. Não
// commitam nada e nunca saem do servidor — são rede de segurança, não entrega.
export function sandboxCheckpointCreate(userId, conversationId, { label = '', reason = 'manual' } = {}) {
  const scope = requireUserScope(userId);
  const ws = workspaceFor(conversationId, scope);
  return createCheckpoint(ws.base, checkpointsDirFor(scope, conversationId), { label, reason });
}

export function sandboxCheckpointList(userId, conversationId) {
  const scope = requireUserScope(userId);
  return listCheckpoints(checkpointsDirFor(scope, conversationId));
}

// Restaurar é destrutivo por natureza (repõe o passado por cima do presente),
// então o estado atual vira um checkpoint automático antes — sem isso, um
// rollback errado não teria volta.
export function sandboxCheckpointRestore(userId, conversationId, id) {
  const scope = requireUserScope(userId);
  const ws = workspaceFor(conversationId, scope);
  const dir = checkpointsDirFor(scope, conversationId);
  let seguranca = null;
  try { seguranca = createCheckpoint(ws.base, dir, { label: 'antes da restauração', reason: 'automatico' }); } catch {}
  return { ...restoreCheckpoint(ws.base, dir, id), checkpoint_de_seguranca: seguranca?.id || null };
}

export function sandboxRuntimeDependencies(userId, conversationId) {
  const scope = requireUserScope(userId);
  return listRuntimeInstalls(workspaceFor(conversationId, scope).agentEnv);
}

export function sandboxForgetRuntimeDependencies(userId, conversationId) {
  const scope = requireUserScope(userId);
  return clearRuntimeInstalls(workspaceFor(conversationId, scope).agentEnv);
}

// Limpeza segura: só o que é descartável por definição. Nunca toca em uploads,
// outputs, artefatos ou checkpoints.
export async function cleanSandboxTemporary(userId, conversationId) {
  const scope = requireUserScope(userId);
  const ws = workspaceFor(conversationId, scope);
  let scripts = 0;
  try {
    for (const name of fs.readdirSync(ws.base)) {
      if (!/^\.tmp_.*\.py$/.test(name)) continue;
      try { fs.rmSync(path.join(ws.base, name), { force: true }); scripts++; } catch {}
    }
  } catch {}
  const runtime = await execInActiveSandbox(scope, conversationId, 'rm -rf /runtime/tmp/* 2>/dev/null; du -sh /runtime/tmp 2>/dev/null || true', 15000).catch(() => null);
  return {
    scripts_temporarios_removidos: scripts,
    runtime_tmp_limpo: !!runtime,
    preservado: 'uploads, outputs, artefatos, cache de pacotes e checkpoints'
  };
}

// Remove o sandbox e o diretório de workspace de uma conversa (usado ao apagar)
export async function destroyConversation(conversationId, userId) {
  conversationId = assertConversationId(conversationId);
  const scope = requireUserScope(userId);
  const key = sessionKey(scope, conversationId);
  const entry = sessions.get(key);
  if (entry) {
    sessions.delete(key);
    noteSandboxTerminated(key, TERMINATION_REASONS.CONVERSATION_REMOVED);
    try { await entry.container.remove({ force: true }); } catch {}
    healthMetrics.sandboxesActive = sessions.size;
  }
  // Remove o diretório escopado E o legado (conversa criada antes da migração
  // de layout e nunca reaberta) — apagar a conversa não pode deixar rastro.
  try { fs.rmSync(path.join(root, WORKSPACE_USERS_DIR, userDirName(scope), conversationId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(root, conversationId), { recursive: true, force: true }); } catch {}
  // Os checkpoints moram fora da árvore da conversa; sem isto, apagar a
  // conversa deixaria cópias íntegras dos arquivos dela no disco.
  try { fs.rmSync(path.join(root, CHECKPOINTS_DIR, userDirName(scope), conversationId), { recursive: true, force: true }); } catch {}
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
