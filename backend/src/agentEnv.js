// Estabilidade do AMBIENTE DE EXECUÇÃO do agente.
//
// PROBLEMA
// O sandbox de uma conversa é um container efêmero. Ele morre por timeout, por
// estouro de saída, por ociosidade, por troca de política, por teto de
// sandboxes por usuário ou simplesmente porque o daemon o derrubou. Quando isso
// acontecia, o modelo NÃO era avisado: continuava trabalhando como se os
// pacotes instalados no turno anterior, os arquivos de /tmp e os processos em
// segundo plano ainda existissem. O resultado prático era o agente repetir
// etapas, reinstalar dependências e — pior — declarar sucesso depois de uma
// execução que havia sido interrompida.
//
// O QUE ESTE MÓDULO FAZ
// Concentra a parte de estabilidade que NÃO precisa do Docker, para poder ser
// testada sem daemon:
//   1) classificação de falhas (ambiente x projeto), a partir do que o comando
//      escreveu na saída — para um "ModuleNotFoundError" não virar diagnóstico
//      de bug no código do usuário;
//   2) registro do CICLO DE VIDA do sandbox e o aviso estruturado de reinício
//      ("o que foi preservado / o que foi perdido"), entregue UMA vez;
//   3) impressão digital do workspace, para dizer com honestidade se um comando
//      interrompido chegou a mexer em arquivos;
//   4) checkpoints do workspace (cópia integral, fora da árvore da conversa),
//      com exclusão de segredos e restauração verificável por hash;
//   5) manifesto de dependências instaladas em runtime, para que a próxima
//      sessão saiba o que reinstalar sem redescobrir por tentativa e erro.
//
// De propósito NÃO importa `sandbox.js`: quem conhece o layout de diretórios é
// o sandbox, que passa os caminhos prontos para cá. Assim não há ciclo de
// import e todo este arquivo é testável com um diretório temporário.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---- 1) Classificação de falhas --------------------------------------------
// Uma dependência ausente parece bug. Um timeout parece teste travado. Um
// container reiniciado parece arquivo perdido pelo código. Sem classificar, o
// agente gasta o turno seguinte investigando o projeto errado.
export const ERROR_CATEGORIES = Object.freeze({
  OK: 'OK',
  ENVIRONMENT: 'ENVIRONMENT_ERROR',
  DEPENDENCY: 'DEPENDENCY_ERROR',
  RESOURCE: 'RESOURCE_LIMIT',
  NETWORK: 'NETWORK_ERROR',
  TEST: 'TEST_FAILURE',
  APPLICATION: 'APPLICATION_ERROR',
  PERMISSION: 'PERMISSION_ERROR',
  TOOL: 'TOOL_ERROR'
});

// Estados possíveis de uma execução. `ok` não significa exit 0 — significa que
// o comando chegou ao FIM por conta própria (o exit code diz o resto).
export const EXEC_STATUS = Object.freeze({
  OK: 'ok',
  TIMEOUT: 'timeout',
  CANCELED: 'cancelado',
  OUTPUT_LIMIT: 'limite_de_saida',
  ENVIRONMENT: 'falha_de_ambiente'
});

const RESOURCE_RE = /No space left on device|Disk quota exceeded|MemoryError|Cannot allocate memory|out of memory|OOMKilled|Killed\s*$|std::bad_alloc|JavaScript heap out of memory/im;
const NETWORK_RE = /Temporary failure in name resolution|Could not resolve host|Name or service not known|Network is unreachable|getaddrinfo|SSLError|Failed to establish a new connection|Could not fetch URL|Connection to .* timed out|npm ERR!\s+network/i;
// Códigos de erro do sistema: SEM `i` e com fronteira de palavra, senão
// "ModuleNotFoundError" casa com ENOTFOUND e uma dependência ausente vira
// "problema de rede" — exatamente o diagnóstico trocado que este módulo existe
// para evitar.
const NETWORK_CODE_RE = /\b(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ENETUNREACH|CERTIFICATE_VERIFY_FAILED)\b/;
const PERMISSION_RE = /Permission denied|Operation not permitted|Read-only file system|EACCES|EPERM|are you root\?/i;
const DEPENDENCY_RE = /ModuleNotFoundError|No module named|ImportError:|cannot open shared object file|command not found|: not found\s*$|Unable to locate package|Cannot find module|is not recognized as an internal|ERR_MODULE_NOT_FOUND|executable file not found/im;
const TEST_RE = /\d+\s+failed|FAILED\s|AssertionError|Tests?:\s+\d+\s+failed|✗|assert\s|Test suite failed to run|FAIL\s+\S+/;

// Pura: (exitCode, saída, status) → categoria + se o projeto é o provável
// culpado + o que fazer a seguir. A ORDEM importa: um `pip install` sem rede
// imprime erro de rede E de dependência; quem manda é a causa raiz.
export function classifyExecOutcome({ exitCode = 0, output = '', status = EXEC_STATUS.OK } = {}) {
  const text = String(output || '');
  const code = Number(exitCode);

  if (status === EXEC_STATUS.CANCELED) {
    return {
      categoria: ERROR_CATEGORIES.TOOL,
      falha_do_projeto: false,
      mensagem: 'Execução cancelada antes de terminar.',
      acao_recomendada: 'Nada foi concluído. Não trate o resultado como sucesso nem como falha do código.'
    };
  }
  if (status === EXEC_STATUS.TIMEOUT) {
    return {
      categoria: ERROR_CATEGORIES.RESOURCE,
      falha_do_projeto: 'indeterminado',
      mensagem: 'O comando excedeu o tempo limite e foi encerrado.',
      acao_recomendada: 'Divida o trabalho em blocos menores (ou aumente o tempo do comando). Só suspeite de laço infinito no código depois de confirmar que a etapa não é apenas longa.'
    };
  }
  if (status === EXEC_STATUS.OUTPUT_LIMIT) {
    return {
      categoria: ERROR_CATEGORIES.RESOURCE,
      falha_do_projeto: 'indeterminado',
      mensagem: 'A saída passou do limite e a execução foi interrompida.',
      acao_recomendada: 'Reduza a saída (redirecione para arquivo, use head/tail) e repita.'
    };
  }
  if (status === EXEC_STATUS.ENVIRONMENT) {
    return {
      categoria: ERROR_CATEGORIES.ENVIRONMENT,
      falha_do_projeto: false,
      mensagem: 'O ambiente de execução falhou antes de o comando terminar.',
      acao_recomendada: 'Repita o comando. Se falhar de novo, consulte a ferramenta ambiente (ação "status").'
    };
  }

  if (code === 0) {
    return { categoria: ERROR_CATEGORIES.OK, falha_do_projeto: false, mensagem: 'Comando concluído.', acao_recomendada: null };
  }
  if (code === 137 || RESOURCE_RE.test(text)) {
    return {
      categoria: ERROR_CATEGORIES.RESOURCE,
      falha_do_projeto: false,
      mensagem: 'Limite de recursos atingido (memória ou disco).',
      acao_recomendada: 'Processe em lotes, libere espaço (ação "limpar_temporarios") e confira a ação "recursos" antes de repetir.'
    };
  }
  if (NETWORK_RE.test(text) || NETWORK_CODE_RE.test(text)) {
    return {
      categoria: ERROR_CATEGORIES.NETWORK,
      falha_do_projeto: false,
      mensagem: 'Falha de rede — o sandbox não alcançou o destino.',
      acao_recomendada: 'A rede do sandbox fica DESLIGADA por padrão. Não insista nem tente contornar: use o cache local ou peça ao usuário que autorize a rede para este pedido.'
    };
  }
  if (PERMISSION_RE.test(text)) {
    return {
      categoria: ERROR_CATEGORIES.PERMISSION,
      falha_do_projeto: false,
      mensagem: 'Permissão negada — a execução roda como usuário sem privilégios.',
      acao_recomendada: 'Grave em /workspace, /artifacts, /cache ou /runtime/tmp. Não há root nem apt no sandbox.'
    };
  }
  if (DEPENDENCY_RE.test(text)) {
    return {
      categoria: ERROR_CATEGORIES.DEPENDENCY,
      falha_do_projeto: false,
      mensagem: 'Dependência ausente no ambiente.',
      acao_recomendada: 'Confira a ação "dependencias" da ferramenta ambiente: se o pacote foi instalado antes e o sandbox reiniciou, restaure em vez de investigar o código.'
    };
  }
  if (TEST_RE.test(text)) {
    return {
      categoria: ERROR_CATEGORIES.TEST,
      falha_do_projeto: true,
      mensagem: 'Testes executaram e falharam.',
      acao_recomendada: 'A falha é do código sob teste. Leia a asserção antes de mexer no ambiente.'
    };
  }
  return {
    categoria: ERROR_CATEGORIES.APPLICATION,
    falha_do_projeto: true,
    mensagem: `O comando terminou com código ${code}.`,
    acao_recomendada: 'Leia a saída: o erro é do programa executado, não do ambiente.'
  };
}

// ---- 2) Ciclo de vida do sandbox e aviso de reinício ------------------------
// Motivos possíveis de encerramento, em português porque vão direto para o
// modelo e para o operador.
export const TERMINATION_REASONS = Object.freeze({
  TIMEOUT: 'timeout',
  OUTPUT_LIMIT: 'limite_de_saida',
  CANCELED: 'cancelado',
  IDLE: 'ocioso',
  POLICY: 'troca_de_politica',
  USER_CAP: 'teto_de_sandboxes_do_usuario',
  PC_FOLDERS: 'pastas_do_pc_alteradas',
  RECONCILE: 'reconciliacao',
  CONVERSATION_REMOVED: 'conversa_removida',
  SHUTDOWN: 'desligamento',
  OOM: 'memoria_esgotada',
  CRASHED: 'encerramento_inesperado'
});

// key (usuário/conversa) -> { generation, containerId, lastTermination, pending }
const lifecycle = new Map();
export const _lifecycleForTests = lifecycle;

function entryFor(key) {
  let e = lifecycle.get(key);
  if (!e) { e = { generation: 0, containerId: null, lastTermination: null, pending: null }; lifecycle.set(key, e); }
  return e;
}

export function noteSandboxTerminated(key, reason = TERMINATION_REASONS.CRASHED, extra = {}) {
  if (!key) return;
  const e = entryFor(key);
  e.lastTermination = { motivo: reason, quando: new Date().toISOString(), containerId: e.containerId, ...extra };
  e.containerId = null;
}

// Chamado quando um container NOVO entra em serviço. Se já havia um antes para
// a mesma chave, isto é um REINÍCIO — e o aviso fica pendente até alguém
// consumi-lo (o preâmbulo do turno ou o primeiro resultado de execução).
export function noteSandboxCreated(key, containerId) {
  if (!key) return { generation: 1, restarted: false };
  const e = entryFor(key);
  const restarted = e.generation > 0;
  e.generation += 1;
  e.containerId = containerId || null;
  if (restarted) {
    e.pending = {
      evento: 'ambiente_reiniciado',
      motivo: e.lastTermination?.motivo || TERMINATION_REASONS.CRASHED,
      quando: new Date().toISOString(),
      geracao_anterior: e.generation - 1,
      geracao_atual: e.generation,
      sandbox_anterior: e.lastTermination?.containerId || null,
      sandbox_atual: containerId || null,
      preservado: ['workspace da conversa (arquivos, uploads e outputs)', 'checkpoints e artefatos', 'cache de pacotes (/cache)', 'manifesto de dependências instaladas'],
      perdido: ['processos em segundo plano e serviços iniciados por você', 'arquivos fora do workspace (inclusive /tmp e /runtime/tmp)', 'pacotes instalados em runtime fora do cache', 'variáveis de ambiente exportadas no shell']
    };
  }
  return { generation: e.generation, restarted };
}

// Consome o aviso (só uma vez — quem pegar, informa).
export function takeRestartNotice(key) {
  const e = lifecycle.get(key);
  if (!e?.pending) return null;
  const notice = e.pending;
  e.pending = null;
  return notice;
}

export function peekSandboxLifecycle(key) {
  const e = lifecycle.get(key);
  if (!e) return { geracao: 0, sandbox_atual: null, ultimo_encerramento: null, aviso_pendente: false };
  return { geracao: e.generation, sandbox_atual: e.containerId, ultimo_encerramento: e.lastTermination, aviso_pendente: !!e.pending };
}

// Texto para o preâmbulo do turno. O modelo não deveria precisar deduzir um
// reinício a partir de falhas posteriores.
export function formatRestartNotice(notice) {
  if (!notice) return null;
  return [
    'AMBIENTE REINICIADO desde a última execução desta conversa.',
    `Motivo: ${notice.motivo}.`,
    `PRESERVADO: ${notice.preservado.join('; ')}.`,
    `PERDIDO: ${notice.perdido.join('; ')}.`,
    'Antes de continuar, confira o estado real (arquivos, dependências) em vez de supor que o que você fez antes ainda está de pé. Não repita trabalho que o workspace já contém.'
  ].join('\n');
}

// ---- 3) Impressão digital do workspace --------------------------------------
// Diretórios que não entram na varredura: caros e reconstruíveis. A pasta em si
// ainda é contada (o mtime dela muda quando algo é criado no topo), então uma
// instalação de pacotes continua aparecendo como "mexeu em arquivos".
export const HEAVY_DIRS = Object.freeze(new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.next', '.nuxt', 'target', '.gradle', '.tox'
]));

// A escrituração do próprio mecanismo (log ao vivo da execução, manifesto de
// dependências) NÃO conta como "o comando mexeu em arquivos" — senão TODA
// execução sairia com arquivos_alterados=true e o campo perderia o sentido.
export const AGENT_ENV_DIR = '.agent-env';

export function fingerprintWorkspace(base, { maxEntries = 20000 } = {}) {
  const fp = { arquivos: 0, bytes: 0, mtime_mais_recente: 0, truncado: false };
  const stack = [base];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > maxEntries) { fp.truncado = true; return fp; }
      // Antes do lstat: o mtime do PRÓPRIO diretório .agent-env muda a cada
      // execução (o log ao vivo é gravado lá), e isso bastaria para a impressão
      // digital acusar mudança em todo comando.
      if (entry.name === AGENT_ENV_DIR) continue;
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.mtimeMs > fp.mtime_mais_recente) fp.mtime_mais_recente = stat.mtimeMs;
      if (entry.isDirectory()) {
        if (!HEAVY_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (/^\.tmp_.*\.py$/.test(entry.name)) continue; // script da própria ferramenta
      fp.arquivos++;
      fp.bytes += stat.size;
    }
  }
  return fp;
}

export function fingerprintChanged(before, after) {
  if (!before || !after) return null; // sem base de comparação: não invente
  return before.arquivos !== after.arquivos
    || before.bytes !== after.bytes
    || before.mtime_mais_recente !== after.mtime_mais_recente;
}

// ---- 4) Checkpoints do workspace --------------------------------------------
// Segredos NUNCA entram num checkpoint (§7 do plano de estabilização): o
// snapshot é uma cópia em claro no disco do servidor.
export const SECRET_PATTERNS = Object.freeze([
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)(secrets|tokens)(\/|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/,
  /(^|\/)\.git\/config$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i
]);

// Diretórios que o checkpoint ignora por peso (reconstruíveis a partir dos
// manifestos) + as áreas internas do próprio mecanismo.
export const CHECKPOINT_SKIPPED_DIRS = Object.freeze(new Set([
  ...HEAVY_DIRS, '.artifacts', '.thumbs', '.agent-env'
]));

export function isSecretPath(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  return SECRET_PATTERNS.some(re => re.test(rel));
}

export function isCheckpointSkipped(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (isSecretPath(rel)) return true;
  return rel.split('/').some(seg => CHECKPOINT_SKIPPED_DIRS.has(seg));
}

const MAX_CHECKPOINT_BYTES = Math.max(1, Number(process.env.CHECKPOINT_MAX_MB || 300)) * 1024 * 1024;
const CHECKPOINT_KEEP = Math.max(1, Number(process.env.CHECKPOINT_KEEP || 5));

// Lista os arquivos elegíveis, com o custo já somado. Separado da cópia para
// que o teto seja verificado ANTES de gravar qualquer coisa (um checkpoint pela
// metade é pior que nenhum).
export function collectCheckpointFiles(base, { maxBytes = MAX_CHECKPOINT_BYTES } = {}) {
  const files = [];
  const ignorados = [];
  let bytes = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? path.join(base, rel) : base;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (isCheckpointSkipped(relPath)) { ignorados.push(relPath); continue; }
      if (entry.isSymbolicLink()) { ignorados.push(relPath); continue; } // link não é conteúdo
      if (entry.isDirectory()) { stack.push(relPath); continue; }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = fs.statSync(path.join(base, relPath)); } catch { continue; }
      bytes += stat.size;
      if (bytes > maxBytes) {
        const err = new Error(`O workspace passa de ${Math.round(maxBytes / 1024 / 1024)} MB e não cabe num checkpoint. Mova o que for descartável para /runtime/tmp ou apague antes de tentar de novo.`);
        err.code = 'CHECKPOINT_TOO_LARGE';
        throw err;
      }
      files.push({ rel: relPath, size: stat.size });
    }
  }
  return { files, bytes, ignorados };
}

function hashFile(full) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); }
  catch { return null; }
}

export function createCheckpoint(base, checkpointsDir, { label = '', reason = 'manual', keep = CHECKPOINT_KEEP, maxBytes = MAX_CHECKPOINT_BYTES } = {}) {
  const { files, bytes, ignorados } = collectCheckpointFiles(base, { maxBytes });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(checkpointsDir, id);
  const dataDir = path.join(dir, 'dados');
  fs.mkdirSync(dataDir, { recursive: true });
  const hashes = {};
  for (const file of files) {
    const from = path.join(base, file.rel);
    const to = path.join(dataDir, file.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.copyFileSync(from, to); } catch { continue; }
    hashes[file.rel] = hashFile(to);
  }
  const meta = {
    id,
    criado_em: new Date().toISOString(),
    rotulo: String(label || '').slice(0, 120),
    motivo: String(reason || '').slice(0, 60),
    arquivos: Object.keys(hashes).length,
    bytes,
    ignorados_por_seguranca_ou_peso: ignorados.slice(0, 50),
    hashes
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  pruneCheckpoints(checkpointsDir, keep);
  return { id, arquivos: meta.arquivos, bytes, ignorados: ignorados.length };
}

export function listCheckpoints(checkpointsDir) {
  let dirs = [];
  try { dirs = fs.readdirSync(checkpointsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
  const out = [];
  for (const name of dirs) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(checkpointsDir, name, 'meta.json'), 'utf8'));
      out.push({ id: meta.id, criado_em: meta.criado_em, rotulo: meta.rotulo, motivo: meta.motivo, arquivos: meta.arquivos, bytes: meta.bytes });
    } catch {}
  }
  return out.sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
}

export function pruneCheckpoints(checkpointsDir, keep = CHECKPOINT_KEEP) {
  const all = listCheckpoints(checkpointsDir);
  let removed = 0;
  for (const cp of all.slice(keep)) {
    try { fs.rmSync(path.join(checkpointsDir, cp.id), { recursive: true, force: true }); removed++; } catch {}
  }
  return removed;
}

// Restaura o snapshot POR CIMA do workspace: repõe os arquivos do checkpoint e
// remove os que nasceram depois dele. O que o checkpoint não guarda (segredos,
// node_modules, .venv) fica intocado — apagar um .env porque ele não cabia no
// snapshot seria destruir dado do usuário para "restaurar" o ambiente.
export function restoreCheckpoint(base, checkpointsDir, id) {
  const dir = path.join(checkpointsDir, String(id || '').replace(/[^A-Za-z0-9_.-]/g, ''));
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); }
  catch {
    const err = new Error(`Checkpoint ${id} não encontrado.`);
    err.code = 'CHECKPOINT_NOT_FOUND';
    throw err;
  }
  const dataDir = path.join(dir, 'dados');
  const wanted = new Set(Object.keys(meta.hashes || {}));

  let removidos = 0;
  const atuais = collectCheckpointFiles(base, { maxBytes: Number.MAX_SAFE_INTEGER });
  for (const file of atuais.files) {
    if (wanted.has(file.rel)) continue;
    try { fs.rmSync(path.join(base, file.rel), { force: true }); removidos++; } catch {}
  }

  let restaurados = 0, divergentes = 0;
  for (const rel of wanted) {
    const from = path.join(dataDir, rel);
    const to = path.join(base, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      try { fs.chownSync(to, 1000, 1000); } catch {}
      restaurados++;
      if (meta.hashes[rel] && hashFile(to) !== meta.hashes[rel]) divergentes++;
    } catch { divergentes++; }
  }
  return { id: meta.id, restaurados, removidos, divergentes, preservados: 'segredos e diretórios pesados não são tocados' };
}

// ---- 5) Dependências instaladas em runtime ----------------------------------
// Pura: reconhece um comando de instalação. Não tenta ser um parser de shell —
// reconhece as formas que os modelos realmente escrevem.
export function detectPackageInstall(command) {
  const cmd = String(command || '');
  const rules = [
    { gerenciador: 'pip', re: /\b(?:python\d?\s+-m\s+)?pip3?\s+install\s+(?!-)/ },
    { gerenciador: 'uv', re: /\buv\s+(?:pip\s+)?(?:install|add)\s+/ },
    { gerenciador: 'poetry', re: /\bpoetry\s+(?:add|install)\b/ },
    { gerenciador: 'npm', re: /\bnpm\s+(?:install|i|ci|add)\b/ },
    { gerenciador: 'yarn', re: /\byarn\s+(?:add|install)\b/ },
    { gerenciador: 'pnpm', re: /\bpnpm\s+(?:add|install|i)\b/ },
    { gerenciador: 'cargo', re: /\bcargo\s+install\s+/ },
    { gerenciador: 'go', re: /\bgo\s+(?:install|get)\s+/ }
  ];
  for (const rule of rules) {
    if (rule.re.test(cmd)) return { gerenciador: rule.gerenciador, comando: cmd.trim().slice(0, 400) };
  }
  return null;
}

const PACKAGES_FILE = 'packages.jsonl';

// O manifesto vive DENTRO do workspace (persistente por definição): sobrevive à
// morte do container, que é exatamente o evento que apaga os pacotes.
export function recordRuntimeInstall(agentEnvDir, command) {
  const detected = detectPackageInstall(command);
  if (!detected) return null;
  try {
    fs.mkdirSync(agentEnvDir, { recursive: true });
    const line = JSON.stringify({ ...detected, quando: new Date().toISOString() });
    fs.appendFileSync(path.join(agentEnvDir, PACKAGES_FILE), `${line}\n`, 'utf8');
    try { fs.chownSync(agentEnvDir, 1000, 1000); } catch {}
  } catch { return null; }
  return detected;
}

export function listRuntimeInstalls(agentEnvDir) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(agentEnvDir, PACKAGES_FILE), 'utf8'); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (seen.has(item.comando)) continue; // o mesmo install repetido não vira duas restaurações
      seen.add(item.comando);
      out.push(item);
    } catch {}
  }
  return out;
}

export function clearRuntimeInstalls(agentEnvDir) {
  try { fs.rmSync(path.join(agentEnvDir, PACKAGES_FILE), { force: true }); return true; } catch { return false; }
}

// ---- 5b) Log ao vivo da execução --------------------------------------------
// O resultado devolvido ao modelo é aparado nos últimos 12 mil caracteres — e o
// erro de uma suíte longa costuma estar no COMEÇO. Enquanto o comando roda, a
// saída inteira é gravada num arquivo dentro do workspace (persistente), então
// depois de um timeout o agente ainda consegue ler o que aconteceu do início.
export const EXEC_LOG_FILE = 'ultima-execucao.log';
export const EXEC_LOG_META = 'ultima-execucao.json';
const EXEC_LOG_MAX_BYTES = Math.max(64 * 1024, Number(process.env.EXEC_LOG_MAX_BYTES || 4 * 1024 * 1024));

// Gravador com teto: passado o limite, para de escrever e marca o corte. Nunca
// lança — perder o log não pode derrubar a execução.
//
// A escrita é SÍNCRONA, num descritor aberto uma única vez. Um createWriteStream
// seria mais idiomático, mas o `close()` dele não garante que os bytes já estão
// no disco: a leitura logo depois (ação "ultima_execucao", feita no mesmo tique)
// encontrava o arquivo vazio. Os pedaços chegam em quadros de dezenas de KB e o
// teto total da saída é de poucos MB, então o custo é irrelevante.
export function openExecLog(agentEnvDir, { maxBytes = EXEC_LOG_MAX_BYTES } = {}) {
  let fd = null;
  let bytes = 0;
  let cortado = false;
  let fechado = false;
  const file = path.join(agentEnvDir, EXEC_LOG_FILE);
  try {
    fs.mkdirSync(agentEnvDir, { recursive: true });
    fd = fs.openSync(file, 'w');
    try { fs.chownSync(agentEnvDir, 1000, 1000); } catch {}
  } catch { fd = null; }
  const escreve = (texto) => { try { fs.writeSync(fd, texto); } catch {} };
  return {
    caminho: `${AGENT_ENV_DIR}/${EXEC_LOG_FILE}`,
    write(chunk) {
      if (fd === null || cortado) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        cortado = true;
        escreve(`\n[LOG CORTADO em ${maxBytes} bytes]\n`);
        return;
      }
      escreve(chunk);
    },
    close(meta) {
      if (fechado) return; // 'end', 'close' e o cancelamento podem chamar juntos
      fechado = true;
      if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; }
      // O sandbox roda como uid 1000 e precisa poder LER o próprio log
      // (o agente o abre com read_file quando quer a saída inteira).
      try { fs.chmodSync(file, 0o666); } catch {}
      if (!meta) return;
      try {
        fs.writeFileSync(path.join(agentEnvDir, EXEC_LOG_META), JSON.stringify({ ...meta, bytes, cortado, log: `${AGENT_ENV_DIR}/${EXEC_LOG_FILE}` }, null, 2), 'utf8');
      } catch {}
    }
  };
}

// Lido pela ferramenta `ambiente` (ação "ultima_execucao"): entrega as duas
// pontas do log, porque a causa costuma estar no começo e o desfecho no fim.
export function readExecLog(agentEnvDir, { headChars = 4000, tailChars = 4000 } = {}) {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(agentEnvDir, EXEC_LOG_META), 'utf8')); } catch {}
  let conteudo = '';
  try { conteudo = fs.readFileSync(path.join(agentEnvDir, EXEC_LOG_FILE), 'utf8'); } catch {}
  if (!meta && !conteudo) return { existe: false };
  const inteiro = conteudo.length <= headChars + tailChars;
  return {
    existe: true,
    ...(meta || {}),
    caracteres: conteudo.length,
    trecho_inicial: inteiro ? conteudo : conteudo.slice(0, headChars),
    ...(inteiro ? {} : { trecho_final: conteudo.slice(-tailChars), observacao: `O log tem ${conteudo.length} caracteres; o meio foi omitido. Leia ${AGENT_ENV_DIR}/${EXEC_LOG_FILE} com read_file para ver tudo.` })
  };
}

// Repórter de progresso: agrega a saída e chama `onProgress` no máximo a cada
// `intervalMs`. Também avisa quando o comando fica MUDO — sem isso, "travou" e
// "está processando em silêncio" são indistinguíveis de fora.
export function createProgressReporter(onProgress, {
  intervalMs = Math.max(200, Number(process.env.SANDBOX_PROGRESS_INTERVAL_MS || 900)),
  stallMs = Math.max(2000, Number(process.env.SANDBOX_STALL_NOTICE_MS || 20000)),
  chunkChars = 2000,
  totalChars = 200_000,
  now = () => Date.now()
} = {}) {
  const inicio = now();
  let pendente = '';
  let enviados = 0;
  let bytes = 0;
  let linhas = 0;
  let ultimaSaida = inicio;
  let ultimoAviso = 0;
  let timer = null;

  const flush = () => {
    const agora = now();
    if (pendente) {
      let trecho = pendente;
      pendente = '';
      if (enviados >= totalChars) return; // teto: para de transmitir, o log em disco continua
      if (trecho.length > chunkChars) trecho = `…${trecho.slice(-chunkChars)}`;
      enviados += trecho.length;
      try { onProgress({ trecho, bytes, linhas, decorrido_ms: agora - inicio }); } catch {}
      return;
    }
    // Nada saiu: só avisa uma vez por janela de silêncio.
    const parado = agora - ultimaSaida;
    if (parado >= stallMs && agora - ultimoAviso >= stallMs) {
      ultimoAviso = agora;
      try { onProgress({ parado_ha_ms: parado, bytes, linhas, decorrido_ms: agora - inicio }); } catch {}
    }
  };

  return {
    start() {
      if (typeof onProgress !== 'function' || timer) return;
      timer = setInterval(flush, intervalMs);
      timer.unref?.();
    },
    push(texto) {
      bytes += Buffer.byteLength(texto);
      for (let i = 0; i < texto.length; i++) if (texto[i] === '\n') linhas++;
      ultimaSaida = now();
      if (typeof onProgress === 'function') pendente += texto;
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (typeof onProgress === 'function' && pendente) flush();
    },
    // Resumo que entra no resultado: quantas linhas saíram e há quanto tempo o
    // comando estava mudo quando foi cortado.
    snapshot() {
      const agora = now();
      return { linhas, bytes, decorrido_ms: agora - inicio, sem_saida_ha_ms: agora - ultimaSaida };
    }
  };
}

// ---- 6) Disco ---------------------------------------------------------------
export function directoryUsage(base, { maxDepth = 2 } = {}) {
  const sizeOf = (dir) => {
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { total += sizeOf(full); continue; }
      try { total += fs.statSync(full).size; } catch {}
    }
    return total;
  };
  const total = sizeOf(base);
  const maiores = [];
  const walkTop = (dir, rel, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      maiores.push({ caminho: relPath, bytes: sizeOf(full) });
      walkTop(full, relPath, depth + 1);
    }
  };
  walkTop(base, '', 1);
  maiores.sort((a, b) => b.bytes - a.bytes);
  return { bytes: total, maiores: maiores.slice(0, 5) };
}

// ---- 7) Manifesto do ambiente -----------------------------------------------
// O que é persistente, o que é descartável, quais são os limites. Sem isto o
// modelo descobre as restrições por tentativa e erro.
export const PERSISTENCE_MAP = Object.freeze({
  '/workspace': 'PERSISTENTE — arquivos da conversa (uploads, outputs, código). Sobrevive a reinício do sandbox.',
  '/workspace/outputs': 'PERSISTENTE — só o que estiver aqui vira cartão de download no chat.',
  '/artifacts': 'PERSISTENTE — relatórios, patches e resultados intermediários que você quer manter sem entregar ao usuário.',
  '/cache': 'PERSISTENTE entre sandboxes do mesmo usuário — cache de pip/npm. Nunca guarde resultado de trabalho aqui.',
  '/runtime/tmp': 'TEMPORÁRIO — apagado quando o sandbox morre. É o TMPDIR do sandbox.',
  '/tmp': 'TEMPORÁRIO — NÃO use para nada que precise sobreviver ao comando seguinte.'
});

export function environmentManifest({ instanceId, sessionKey, generation = 0, limits = {}, network = false, workspace = {} } = {}) {
  return {
    identificadores: {
      environment_id: instanceId || null,
      session_key: sessionKey || null,
      geracao_do_sandbox: generation
    },
    limites: {
      memoria_mb: limits.memoryMb ?? null,
      cpus: limits.cpus ?? null,
      processos_max: limits.pids ?? null,
      tempo_max_por_comando_s: limits.commandTimeoutMs ? Math.round(limits.commandTimeoutMs / 1000) : null,
      saida_max_bytes: limits.maxOutputBytes ?? null,
      ocioso_ate_reciclar_min: limits.idleTtlMs ? Math.round(limits.idleTtlMs / 60000) : null,
      sandboxes_simultaneos_por_usuario: limits.maxSandboxesPerUser ?? null
    },
    rede: {
      disponivel_no_sandbox: !!network,
      observacao: network
        ? 'Autorizada apenas para o objetivo atual deste pedido.'
        : 'Desligada. pip/npm/curl/wget não alcançam a internet — use o cache local ou peça autorização ao usuário.'
    },
    persistencia: PERSISTENCE_MAP,
    workspace: {
      caminho: workspace.base || null,
      arquivos: workspace.arquivos ?? null,
      bytes: workspace.bytes ?? null
    }
  };
}
