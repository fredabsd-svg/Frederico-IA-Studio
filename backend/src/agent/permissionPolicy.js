// Política de permissões de shell do agente — allow / ask / deny por padrão de
// comando (Developer Workspace 3.0, Fases 16–18).
//
// O desenho segue o que funciona nos produtos de referência (OpenCode/Codex):
//  - regras ORDENADAS com padrões glob simples (`*` = qualquer trecho,
//    `?` = um caractere); a ÚLTIMA regra que casa vence — o catch-all vem
//    primeiro e as exceções depois;
//  - comandos compostos "lineares" (a && b; c | d) são divididos e cada
//    segmento é avaliado; vale a decisão mais restritiva (deny > ask > allow);
//  - `ask` não trava a execução no meio: a ferramenta devolve um erro
//    estruturado (PERMISSION_REQUIRED) instruindo o modelo a usar `ask_user`,
//    e a confirmação do usuário vira uma AUTORIZAÇÃO ESTRUTURADA
//    (`commandGrants`), re-validada aqui a cada turno — o mesmo contrato da
//    autorização de publicação no GitHub (githubAccess.js).
//
// LIMITE HONESTO: isto é política de produto, não fronteira de segurança. A
// divisão de comandos é textual e não interpreta aspas/substituição; quem
// impede dano real continua sendo o sandbox isolado, o docker-guard e o
// execGuard (git remoto bloqueado, egress fail-closed). Uma regra daqui nunca
// AFROUXA essas fronteiras — só adiciona portões acima delas.

export const SHELL_PERMISSION_DECISIONS = Object.freeze(['allow', 'ask', 'deny']);

// Política padrão. Ordem importa (última que casa vence).
// Os `deny` daqui DUPLICAM fronteiras que já existem em execGuard/sandbox — a
// duplicação é intencional: a recusa chega ao modelo com um motivo de POLÍTICA
// claro antes de o comando sequer tocar o executor.
export const DEFAULT_SHELL_POLICY = Object.freeze([
  { pattern: '*', decision: 'allow', reason: 'o sandbox isolado é a fronteira; leitura e execução comuns não pedem confirmação' },
  { pattern: 'sudo *', decision: 'deny', reason: 'não existe privilégio de root no sandbox' },
  { pattern: 'docker *', decision: 'deny', reason: 'o sandbox não controla o Docker (docker-guard é a fronteira)' },
  { pattern: 'git push*', decision: 'deny', reason: 'git remoto pelo sandbox é bloqueado — publique com github_push, após autorização' },
  { pattern: 'git reset --hard*', decision: 'ask', reason: 'descarta alterações não commitadas de forma irrecuperável' },
  { pattern: 'git clean*', decision: 'ask', reason: 'apaga arquivos não rastreados de forma irrecuperável' },
  { pattern: 'git restore*', decision: 'ask', reason: 'sobrescreve alterações não commitadas' },
  { pattern: 'git checkout -- *', decision: 'ask', reason: 'sobrescreve alterações não commitadas' }
]);

// Padrões que uma autorização do usuário pode liberar. SÓ os `ask` da política
// padrão: um grant vindo do cliente com um padrão fora desta lista é ignorado
// (falha fechada) — o frontend registra a decisão, mas quem concede é o backend.
export const ASKABLE_PATTERNS = Object.freeze(
  DEFAULT_SHELL_POLICY.filter(rule => rule.decision === 'ask').map(rule => rule.pattern)
);

// Glob simples e ancorado: `git push*` casa "git push origin main" e não casa
// "meu-git pushzão" (o início precisa bater). Espaços múltiplos do comando são
// colapsados antes do match para "git  reset   --hard" não escapar por formato.
export function matchesCommandPattern(pattern, command) {
  const normalized = String(command || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  const escaped = String(pattern || '')
    .trim().replace(/\s+/g, ' ')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[\\s\\S]*')
    .replace(/\?/g, '.');
  if (!escaped) return false;
  return new RegExp(`^${escaped}$`).test(normalized);
}

// Divisão "linear" de comandos compostos: && || ; | e quebras de linha.
// Não interpreta aspas nem substituição — é deliberadamente simples (ver o
// limite honesto no topo). Segmentos vazios somem.
export function splitShellCommand(command) {
  return String(command || '')
    .split(/&&|\|\||;|\||\n/)
    .map(part => part.trim())
    .filter(Boolean);
}

const RANK = { allow: 0, ask: 1, deny: 2 };

// Avalia UM comando (possivelmente composto) contra a política + autorizações
// da tarefa. Devolve a decisão mais restritiva entre os segmentos, com a regra
// e o segmento que a causaram. `grants` são padrões já autorizados pelo
// usuário (ver normalizeCommandGrants) — entram como allow DEPOIS da política,
// então vencem um `ask` (última que casa vence) mas nunca um `deny`, porque o
// deny é conferido por último.
export function evaluateShellCommand(command, { policy = DEFAULT_SHELL_POLICY, grants = [] } = {}) {
  const segments = splitShellCommand(command);
  if (!segments.length) return { decision: 'allow', rule: null, segment: '' };
  const grantRules = grants.map(pattern => ({ pattern, decision: 'allow', reason: 'autorizado pelo usuário nesta tarefa' }));
  let worst = { decision: 'allow', rule: null, segment: '' };
  for (const segment of segments) {
    let matched = null;
    for (const rule of policy) {
      if (matchesCommandPattern(rule.pattern, segment)) matched = rule;
    }
    // Autorizações do usuário: só rebaixam `ask` para allow. `deny` é imutável.
    if (matched?.decision === 'ask') {
      for (const grant of grantRules) {
        if (matchesCommandPattern(grant.pattern, segment)) matched = grant;
      }
    }
    const decision = matched?.decision || 'allow';
    if (RANK[decision] > RANK[worst.decision]) {
      worst = { decision, rule: matched, segment };
      if (decision === 'deny') break;
    }
  }
  return worst;
}

// Normaliza as autorizações de comando vindas do cliente
// (`developer.permissions.commandGrants`). Falha fechada: só sobrevivem
// padrões que a PRÓPRIA política marca como `ask` — o cliente registra a
// decisão do usuário, mas não inventa escopo novo.
export function normalizeCommandGrants(rawPermissions) {
  const raw = rawPermissions?.commandGrants;
  if (!Array.isArray(raw)) return [];
  const grants = [];
  for (const item of raw) {
    const pattern = typeof item === 'string' ? item : String(item?.pattern || '');
    const clean = pattern.trim().replace(/\s+/g, ' ');
    if (clean && ASKABLE_PATTERNS.includes(clean) && !grants.includes(clean)) grants.push(clean);
  }
  return grants;
}
