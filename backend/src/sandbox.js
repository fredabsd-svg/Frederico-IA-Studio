import Docker from 'dockerode';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const root = path.resolve(process.env.WORKSPACE_ROOT || './workspaces');
// Caminho no HOST correspondente a `root`. Binds do Docker são interpretados
// pelo daemon como caminhos do host — quando o backend roda em container,
// os dois caminhos diferem. Sem isso, o sandbox monta um diretório vazio.
const hostRoot = process.env.HOST_WORKSPACE_ROOT || root;
const image = process.env.SANDBOX_IMAGE || 'frederico-ai-sandbox:latest';
const memory = process.env.SANDBOX_MEMORY || '1024m';
const cpus = Number(process.env.SANDBOX_CPUS || 1);

fs.mkdirSync(root, { recursive: true });
const sessions = new Map(); // id -> { container, lastUsed }

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
  const base = path.join(root, id);
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

export async function getContainer(conversationId) {
  const entry = sessions.get(conversationId);
  if (entry) { entry.lastUsed = Date.now(); return entry.container; }
  await ensureSandboxImage();
  const { base } = workspaceFor(conversationId);
  const hostBase = path.join(hostRoot, conversationId);
  const name = `frederico-ai-${conversationId}-${nanoid(5)}`;
  const container = await docker.createContainer({
    Image: image,
    name,
    WorkingDir: '/workspace',
    Cmd: ['sleep', 'infinity'],
    Tty: false,
    OpenStdin: false,
    NetworkDisabled: true,
    HostConfig: {
      Binds: [`${hostBase}:/workspace`],
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
  sessions.set(conversationId, { container, lastUsed: Date.now() });
  return container;
}

function parseMemory(value) {
  const m = String(value).match(/^(\d+)(m|g)?$/i);
  if (!m) return 1024 * 1024 * 1024;
  const n = Number(m[1]);
  return (m[2] || '').toLowerCase() === 'g' ? n * 1024 ** 3 : n * 1024 ** 2;
}

export async function execInSandbox(conversationId, cmd, timeoutMs = Number(process.env.TOOL_TIMEOUT_MS || 45000)) {
  let container = await getContainer(conversationId);
  let exec;
  try {
    exec = await container.exec({
      Cmd: ['bash', '-lc', cmd],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: '/workspace',
      User: 'sandbox'
    });
  } catch (err) {
    // Container morreu (ex.: kill por timeout anterior + AutoRemove).
    // Remove a referência morta e recria uma vez.
    sessions.delete(conversationId);
    container = await getContainer(conversationId);
    exec = await container.exec({
      Cmd: ['bash', '-lc', cmd],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: '/workspace',
      User: 'sandbox'
    });
  }
  const stream = await exec.start({ hijack: true, stdin: false });
  let output = '';
  let timedOut = false;
  const timer = setTimeout(async () => {
    timedOut = true;
    sessions.delete(conversationId); // referência ficaria morta após o kill
    try { await container.kill(); } catch {}
  }, timeoutMs);
  return await new Promise((resolve) => {
    stream.on('data', chunk => { output += chunk.toString('utf8').replace(/[\x00-\x08\x0E-\x1F]/g, ''); });
    stream.on('end', async () => {
      clearTimeout(timer);
      const info = await exec.inspect().catch(() => ({ ExitCode: -1 }));
      if (timedOut) output += `\n[TIMEOUT: comando excedeu ${timeoutMs / 1000}s — sandbox reiniciado]`;
      resolve({ exitCode: timedOut ? 124 : info.ExitCode, output: output.slice(-12000) });
    });
  });
}

// Remove o sandbox e o diretório de workspace de uma conversa (usado ao apagar)
export async function destroyConversation(conversationId) {
  const entry = sessions.get(conversationId);
  if (entry) {
    sessions.delete(conversationId);
    try { await entry.container.remove({ force: true }); } catch {}
  }
  try { fs.rmSync(path.join(root, conversationId), { recursive: true, force: true }); } catch {}
}

export function safeJoin(base, userPath) {
  const clean = String(userPath || '').replace(/^\/+/, '');
  const full = path.resolve(base, clean);
  if (!full.startsWith(path.resolve(base))) throw new Error('Caminho bloqueado por segurança.');
  return full;
}
