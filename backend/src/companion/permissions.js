// Modelo de permissões granular do copiloto (seção 16). Define O QUE o agente
// pode fazer, por NÍVEL de autonomia (1..5), com overrides do usuário, listas de
// comandos permitidos/bloqueados, modo somente-leitura e parada de emergência.
// É o motor de POLÍTICA (decisão) — a decisão é consultada antes de agir e toda
// ação fica na auditoria (companion/audit.js). Puro + persistência via settings.
import { db } from '../db.js';

// Todas as capacidades controláveis (seção 16).
export const CAPABILITIES = [
  'observar', 'ler_arquivos', 'criar_arquivos', 'editar_arquivos', 'excluir_arquivos',
  'executar_seguros', 'instalar_deps', 'reiniciar_servicos', 'gerenciar_containers',
  'alterar_config', 'acessar_internet', 'consultar_git', 'criar_commits', 'abrir_prs',
  'notificar', 'acessar_logs', 'acessar_env',
];

// Capacidades concedidas por NÍVEL (padrão). Níveis altos incluem os baixos.
// 1 = só observar/ler; 2 = preparar (criar/editar em rascunho); 3 = executar com
// confirmação; 4 = automação limitada (deps/serviços/containers); 5 = avançado.
const LEVEL_CAPS = {
  1: ['observar', 'ler_arquivos', 'acessar_logs', 'consultar_git'],
  2: ['criar_arquivos', 'editar_arquivos', 'notificar'],
  3: ['executar_seguros', 'acessar_internet', 'criar_commits'],
  4: ['instalar_deps', 'reiniciar_servicos', 'gerenciar_containers', 'abrir_prs', 'alterar_config'],
  5: ['excluir_arquivos', 'acessar_env'],
};

// Capacidades SENSÍVEIS: sempre exigem confirmação explícita, mesmo no nível 5.
export const SENSITIVE = new Set(['excluir_arquivos', 'instalar_deps', 'reiniciar_servicos', 'gerenciar_containers', 'alterar_config', 'acessar_env', 'abrir_prs']);

export function capabilitiesForLevel(level) {
  const n = Math.min(5, Math.max(1, Number(level) || 1));
  const caps = new Set();
  for (let l = 1; l <= n; l++) for (const c of (LEVEL_CAPS[l] || [])) caps.add(c);
  return [...caps];
}

// Comando destrutivo? (rede de segurança independente do nível). Espelha o
// espírito do guard de comandos do tools.js.
const DESTRUCTIVE_RE = /\b(rm\s+-rf|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|drop\s+database|drop\s+table|truncate\s+table|git\s+push\s+--force|chmod\s+-R\s+777|>\s*\/dev\/sd)/i;
export function isDestructiveCommand(cmd = '') {
  return DESTRUCTIVE_RE.test(String(cmd || ''));
}

const DEFAULTS = Object.freeze({ level: 1, readOnly: false, emergencyStop: false, grant: [], revoke: [], allowList: [], blockList: [] });
const KEY = (userId) => `companion_perms:${userId}`;

function sanitize(input = {}) {
  const arr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 200) : []);
  const caps = (v) => arr(v).filter(c => CAPABILITIES.includes(c));
  return {
    level: Math.min(5, Math.max(1, Number(input.level) || 1)),
    readOnly: !!input.readOnly,
    emergencyStop: !!input.emergencyStop,
    grant: caps(input.grant),      // capacidades concedidas além do nível
    revoke: caps(input.revoke),    // capacidades retiradas
    allowList: arr(input.allowList),
    blockList: arr(input.blockList),
  };
}

export async function readPermissions(userId) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key=?').get(KEY(userId));
    return row?.value ? sanitize(JSON.parse(row.value)) : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}

export async function writePermissions(userId, input) {
  const clean = sanitize(input);
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(KEY(userId), JSON.stringify(clean));
  return clean;
}

// Capacidades EFETIVAS = nível + concedidas − retiradas.
export function resolveCapabilities(perms) {
  const set = new Set(capabilitiesForLevel(perms.level));
  for (const c of (perms.grant || [])) set.add(c);
  for (const c of (perms.revoke || [])) set.delete(c);
  return [...set];
}

// DECISÃO central (pura): a ação é permitida? Precisa de confirmação? Por quê?
// `capability` é uma das CAPABILITIES; `command` (opcional) é checado contra as
// listas e o guard destrutivo.
export function decide(perms, capability, { command = null } = {}) {
  const p = perms || DEFAULTS;
  if (p.emergencyStop) return { allowed: false, requiresConfirmation: false, reason: 'Parada de emergência ativa — nenhuma ação é executada.' };

  const writeCaps = new Set(['criar_arquivos', 'editar_arquivos', 'excluir_arquivos', 'executar_seguros', 'instalar_deps', 'reiniciar_servicos', 'gerenciar_containers', 'alterar_config', 'criar_commits', 'abrir_prs']);
  if (p.readOnly && writeCaps.has(capability)) {
    return { allowed: false, requiresConfirmation: false, reason: 'Modo somente-leitura — apenas observação/leitura é permitida.' };
  }

  if (command) {
    const cmd = String(command);
    if ((p.blockList || []).some(b => cmd.includes(b))) return { allowed: false, requiresConfirmation: false, reason: `Comando na lista de bloqueados.` };
    if (isDestructiveCommand(cmd) && !(p.allowList || []).some(a => cmd.includes(a))) {
      return { allowed: false, requiresConfirmation: true, reason: 'Comando destrutivo — exige confirmação explícita do usuário.' };
    }
  }

  const caps = resolveCapabilities(p);
  if (!caps.includes(capability)) {
    return { allowed: false, requiresConfirmation: true, reason: `Capacidade "${capability}" acima do nível de autonomia atual (nível ${p.level}). Peça autorização.` };
  }
  if (SENSITIVE.has(capability)) {
    return { allowed: true, requiresConfirmation: true, reason: 'Ação sensível — sempre confirmar antes de executar.' };
  }
  return { allowed: true, requiresConfirmation: false, reason: 'Dentro do nível de autonomia.' };
}
