// Política do guarda do Docker — a parte PURA e testável.
//
// PROBLEMA (F-04 da auditoria de 2026-07)
// O backend montava /var/run/docker.sock. Quem controla esse socket controla o
// host: basta criar um container com Privileged:true e "/" montado para virar
// root na máquina. Uma RCE no processo Node deixava de ser "comprometeu o
// backend" e virava "comprometeu o servidor".
//
// POR QUE NÃO UM PROXY DE PRATELEIRA
// Os proxies conhecidos de socket Docker filtram por MÉTODO e CAMINHO. Como o
// app precisa legitimamente de POST /containers/create, liberar esse caminho
// libera junto o corpo que cria um container privilegiado. Filtrar rota não
// fecha o buraco — é preciso ler e validar o CORPO da requisição.
//
// O QUE ESTE MÓDULO FAZ
// Dado (método, caminho, corpo), decide se a requisição passa. Três camadas:
//   1) allowlist de rotas: só o que o sandbox realmente usa;
//   2) validação do corpo de /containers/create: a configuração de segurança é
//      OBRIGATÓRIA (fail-closed) e tudo que permite fuga é recusado;
//   3) posse: operações sobre um container exigem a label do Frederico
//      (verificada pelo servidor, não aqui — ver server.js).
//
// Regra de ouro: negar por padrão. Rota nova = ajuste explícito aqui.

export const APP_LABEL = 'com.frederico.app';
export const APP_LABEL_VALUE = 'frederico-ai-studio';

// A API do Docker aceita prefixo de versão (/v1.41/containers/create).
export function stripApiVersion(pathname) {
  return String(pathname || '').replace(/^\/v\d+\.\d+/, '');
}

const ID = '[a-zA-Z0-9_.-]+';
// Nome de imagem aceita ":" (tag), "/" (repositório) e "@" (digest) — por isso
// não usa o mesmo charset dos ids. Travessia com ".." é barrada logo abaixo.
const IMAGE = '[A-Za-z0-9_.:@/-]+';

// Rotas liberadas. `owned` marca as que agem sobre um container/exec específico
// e por isso exigem checagem de posse pela label (feita no server.js).
const ROUTES = [
  { method: 'GET',    re: /^\/_ping$/,                          owned: null },
  { method: 'HEAD',   re: /^\/_ping$/,                          owned: null },
  { method: 'GET',    re: /^\/version$/,                        owned: null },
  { method: 'GET',    re: new RegExp(`^/images/${IMAGE}/json$`),  owned: null },
  { method: 'GET',    re: /^\/containers\/json$/,               owned: null },
  { method: 'POST',   re: /^\/containers\/create$/,             owned: null, validate: 'create' },
  { method: 'GET',    re: new RegExp(`^/containers/(${ID})/json$`),  owned: 'container' },
  { method: 'POST',   re: new RegExp(`^/containers/(${ID})/start$`), owned: 'container' },
  { method: 'POST',   re: new RegExp(`^/containers/(${ID})/stop$`),  owned: 'container' },
  { method: 'POST',   re: new RegExp(`^/containers/(${ID})/kill$`),  owned: 'container' },
  { method: 'POST',   re: new RegExp(`^/containers/(${ID})/wait$`),  owned: 'container' },
  { method: 'DELETE', re: new RegExp(`^/containers/(${ID})$`),       owned: 'container' },
  { method: 'POST',   re: new RegExp(`^/containers/(${ID})/exec$`),  owned: 'container', validate: 'exec' },
  { method: 'POST',   re: new RegExp(`^/exec/(${ID})/start$`),       owned: 'exec' },
  { method: 'GET',    re: new RegExp(`^/exec/(${ID})/json$`),        owned: 'exec' }
];

function deny(reason) { return { allow: false, reason }; }

// ---- Caminhos de bind ------------------------------------------------------
// Normaliza sem tocar no disco (o guarda não vê o sistema de arquivos do host).
// Aceita caminho POSIX (`/a/b`) e caminho do WINDOWS (`C:\a\b` ou `C:/a/b`):
// com o Docker Desktop o daemon roda no Windows e os binds chegam com letra de
// unidade. Devolve a forma canônica (`/a/b` ou `C:/a/b`) ou `null` quando não é
// um caminho absoluto — aí é bind por NOME (volume), tratado à parte.
export function normalizeHostPath(p) {
  const raw = String(p || '').trim().replace(/\\/g, '/');
  if (raw.startsWith('//')) return null;          // UNC (\\servidor\share): fora do escopo
  const windows = /^[A-Za-z]:\//.test(raw);
  if (!windows && !raw.startsWith('/')) return null;
  const drive = windows ? `${raw[0].toUpperCase()}:` : '';
  const parts = [];
  for (const seg of (windows ? raw.slice(2) : raw).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return `${drive}/${parts.join('/')}`;
}

const isWindowsPath = (p) => /^[A-Za-z]:\//.test(String(p || ''));

export function isInsideRoot(target, root) {
  const t = normalizeHostPath(target);
  const r = normalizeHostPath(root);
  if (!t || !r) return false;
  // O Windows não diferencia maiúsculas de minúsculas: comparar sensível faria o
  // guarda recusar o PRÓPRIO workspace só porque a unidade veio como "c:".
  const ci = isWindowsPath(t) && isWindowsPath(r);
  const a = ci ? t.toLowerCase() : t;
  const b = ci ? r.toLowerCase() : r;
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

// Caminhos que NUNCA podem ser montados, mesmo com pastas do PC liberadas.
// O socket do Docker encabeça a lista: montá-lo no sandbox reabriria o F-04 por
// dentro. Os demais são a mesma blocklist das "Pastas do PC" (routes/pcFolders).
const FORBIDDEN_SOURCES = [
  /^\/$/,
  /^\/var\/run(\/|$)/, /^\/run(\/|$)/,
  /^\/proc(\/|$)/, /^\/sys(\/|$)/, /^\/dev(\/|$)/, /^\/boot(\/|$)/,
  /^\/etc(\/|$)/, /^\/root(\/|$)/,
  /^\/bin(\/|$)/, /^\/sbin(\/|$)/, /^\/lib\d*(\/|$)/, /^\/usr(\/|$)/,
  /^\/var\/lib\/docker(\/|$)/
];

// Equivalentes do Windows, para o Docker Desktop. Sem eles, ligar "Pastas do PC"
// num host Windows ficaria SEM blocklist nenhuma (as regras acima são POSIX e
// nunca casariam com `C:/...`).
const FORBIDDEN_WINDOWS_SOURCES = [
  /^[a-z]:\/$/,
  /^[a-z]:\/windows(\/|$)/,
  /^[a-z]:\/program files( \(x86\))?(\/|$)/,
  /^[a-z]:\/programdata(\/|$)/,
  /^[a-z]:\/users\/[^/]+\/appdata(\/|$)/
];

// O socket do Docker nunca, em hipótese alguma: montá-lo no sandbox reabriria o
// F-04 por dentro. Fica separado da blocklist porque é o único item que NEM a
// precedência do workspace pode liberar.
export function isDockerSocket(source) {
  const norm = normalizeHostPath(source);
  return !norm || /docker\.sock$/.test(norm) || /docker_engine$/i.test(norm);
}

export function isForbiddenSource(source) {
  const norm = normalizeHostPath(source);
  if (!norm) return true;
  if (isDockerSocket(norm)) return true;
  if (isWindowsPath(norm)) return FORBIDDEN_WINDOWS_SOURCES.some(re => re.test(norm.toLowerCase()));
  return FORBIDDEN_SOURCES.some(re => re.test(norm));
}

// "src:dst:mode" → src.
export function bindSource(bind) {
  const s = String(bind || '');
  // O dois-pontos da LETRA DE UNIDADE ("C:\dir:/workspace") NÃO separa origem de
  // destino. Sem esta ressalva a origem virava "C", que não começa com "/", e o
  // guarda recusava TODO container como "volume nomeado" no Docker Desktop.
  const from = /^[A-Za-z]:[\\/]/.test(s) ? 2 : 0;
  const idx = s.indexOf(':', from);
  return idx === -1 ? s : s.slice(0, idx);
}

// ---- Validação de POST /containers/create ----------------------------------
export function validateCreate(body, limits) {
  if (!body || typeof body !== 'object') return deny('corpo ausente ou não é JSON');
  const host = body.HostConfig || {};

  // 1) Imagem: só a imagem do sandbox. Bloqueia subir qualquer coisa do registry.
  if (limits.allowedImage && body.Image !== limits.allowedImage) {
    return deny(`imagem não permitida: ${body.Image} (só ${limits.allowedImage})`);
  }

  // 2) Identidade: sem a label do app o container ficaria invisível para a
  //    reconciliação de órfãos e para a checagem de posse.
  const labels = body.Labels || {};
  if (labels[APP_LABEL] !== APP_LABEL_VALUE) {
    return deny(`o container precisa da label ${APP_LABEL}=${APP_LABEL_VALUE}`);
  }

  // 3) Fuga direta do container.
  if (host.Privileged) return deny('Privileged não é permitido');
  if (Array.isArray(host.CapAdd) && host.CapAdd.length) return deny(`CapAdd não é permitido: ${host.CapAdd.join(',')}`);
  if (Array.isArray(host.Devices) && host.Devices.length) return deny('Devices não é permitido');
  if (Array.isArray(host.DeviceRequests) && host.DeviceRequests.length) return deny('DeviceRequests (GPU) não é permitido');
  if (host.PidMode) return deny(`PidMode não é permitido: ${host.PidMode}`);
  if (host.IpcMode && !/^(private|none)$/.test(String(host.IpcMode))) return deny(`IpcMode não é permitido: ${host.IpcMode}`);
  if (host.UTSMode) return deny(`UTSMode não é permitido: ${host.UTSMode}`);
  if (host.UsernsMode) return deny(`UsernsMode não é permitido: ${host.UsernsMode}`);
  if (host.CgroupParent) return deny('CgroupParent não é permitido');
  if (host.Sysctls && Object.keys(host.Sysctls).length) return deny('Sysctls não é permitido');
  if (host.NetworkMode && /^(host|container:)/.test(String(host.NetworkMode))) {
    return deny(`NetworkMode não é permitido: ${host.NetworkMode}`);
  }

  // 4) Endurecimento OBRIGATÓRIO (fail-closed): mesmo um backend comprometido
  //    não consegue pedir um container "mole".
  const capDrop = (host.CapDrop || []).map(c => String(c).toUpperCase());
  if (!capDrop.includes('ALL')) return deny('CapDrop precisa conter ALL');
  const securityOpt = (host.SecurityOpt || []).map(String);
  if (!securityOpt.some(o => /^no-new-privileges:?(true)?$/.test(o))) {
    return deny('SecurityOpt precisa conter no-new-privileges:true');
  }
  if (securityOpt.some(o => /^(seccomp|apparmor)[:=]unconfined$/i.test(o))) {
    return deny('seccomp/apparmor unconfined não é permitido');
  }

  // 5) Cotas de recursos: obrigatórias e com teto (evita esgotar o host).
  const pids = Number(host.PidsLimit || 0);
  if (!pids || pids > limits.maxPids) return deny(`PidsLimit precisa estar entre 1 e ${limits.maxPids} (recebido: ${host.PidsLimit})`);
  const memory = Number(host.Memory || 0);
  if (!memory || memory > limits.maxMemoryBytes) return deny(`Memory precisa estar entre 1 e ${limits.maxMemoryBytes} (recebido: ${host.Memory})`);
  const nanoCpus = Number(host.NanoCpus || 0);
  if (!nanoCpus || nanoCpus > limits.maxNanoCpus) return deny(`NanoCpus precisa estar entre 1 e ${limits.maxNanoCpus} (recebido: ${host.NanoCpus})`);

  // 6) Montagens — o coração do F-04.
  const sources = [];
  for (const bind of host.Binds || []) {
    const src = bindSource(bind);
    if (!normalizeHostPath(src)) return deny(`bind por volume nomeado não é permitido: ${bind}`);
    sources.push({ source: src, origem: 'Binds' });
  }
  for (const mount of host.Mounts || []) {
    if (mount?.Type !== 'bind') return deny(`Mount do tipo "${mount?.Type}" não é permitido (só bind)`);
    sources.push({ source: String(mount.Source || ''), origem: 'Mounts' });
  }
  for (const { source, origem } of sources) {
    // O socket do Docker é barrado ANTES de tudo e não tem exceção.
    if (isDockerSocket(source)) return deny(`${origem}: caminho proibido no host: ${source}`);
    // O PRÓPRIO workspace do app tem precedência sobre a blocklist de diretórios
    // de sistema. Numa VPS o deploy quase sempre fica em /root/<projeto> (é o
    // que o VPS-DEPLOY.md manda fazer: `git clone` logado como root), então
    // GUARD_WORKSPACE_ROOT vira /root/<projeto>/workspaces e a regra /^\/root/
    // recusava TODO container do app — o sandbox ficava inutilizável.
    // A raiz vem da configuração do operador, não do backend: confiar nela aqui
    // não amplia a superfície que o F-04 fecha.
    const dentroDoWorkspace = limits.workspaceRoot && isInsideRoot(source, limits.workspaceRoot);
    if (dentroDoWorkspace) continue;
    if (isForbiddenSource(source)) return deny(`${origem}: caminho proibido no host: ${source}`);
    // Fora do workspace só quando o operador liga "Pastas do PC" no guarda —
    // e mesmo assim a blocklist acima continua valendo.
    if (!limits.allowPcFolders) {
      return deny(`${origem}: ${source} está fora de ${limits.workspaceRoot} (para permitir pastas do PC, ligue GUARD_ALLOW_PC_FOLDERS=true no guarda)`);
    }
    if (limits.extraBindRoots?.length && !limits.extraBindRoots.some(root => isInsideRoot(source, root))) {
      return deny(`${origem}: ${source} está fora das raízes autorizadas (GUARD_EXTRA_BIND_ROOTS)`);
    }
  }

  return { allow: true };
}

// Exec: o container já é do app (posse conferida). Só barramos escalada.
export function validateExec(body) {
  if (body && body.Privileged) return deny('exec Privileged não é permitido');
  if (body && String(body.User || '') === 'root') return deny('exec como root não é permitido');
  return { allow: true };
}

export function defaultLimits(env = process.env) {
  const num = (name, fallback) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    allowedImage: env.SANDBOX_IMAGE || 'frederico-ai-sandbox:latest',
    workspaceRoot: env.GUARD_WORKSPACE_ROOT || env.HOST_WORKSPACE_ROOT || '/app/workspaces',
    allowPcFolders: env.GUARD_ALLOW_PC_FOLDERS === 'true',
    extraBindRoots: String(env.GUARD_EXTRA_BIND_ROOTS || '').split(',').map(s => s.trim()).filter(Boolean),
    maxPids: num('GUARD_MAX_PIDS', 1024),
    maxMemoryBytes: num('GUARD_MAX_MEMORY_MB', 8192) * 1024 * 1024,
    maxNanoCpus: num('GUARD_MAX_CPUS', 4) * 1e9
  };
}

// Decisão completa de uma requisição. `body` só é usado nas rotas com validação.
export function evaluateRequest({ method, path: rawPath, body }, limits = defaultLimits()) {
  const upper = String(method || '').toUpperCase();
  const pathname = stripApiVersion(String(rawPath || '').split('?')[0]);

  // Travessia no caminho nunca é legítima na API do Docker e poderia fazer uma
  // rota liberada casar com outra coisa depois da normalização do daemon.
  if (pathname.includes('..')) return deny(`caminho com travessia: ${pathname}`);

  const route = ROUTES.find(r => r.method === upper && r.re.test(pathname));
  if (!route) return deny(`rota não permitida: ${upper} ${pathname}`);

  if (route.validate === 'create') {
    const verdict = validateCreate(body, limits);
    if (!verdict.allow) return verdict;
  }
  if (route.validate === 'exec') {
    const verdict = validateExec(body);
    if (!verdict.allow) return verdict;
  }

  const match = route.owned ? route.re.exec(pathname) : null;
  return { allow: true, ownership: route.owned, targetId: match?.[1] || null };
}
