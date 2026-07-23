// Monitoramento do Companion de desenvolvimento (Fase 2): transforma sinais
// reais que o backend já enxerga em eventos/alertas do Companion, respeitando o
// modo de comportamento do usuário. Sinais cobertos neste MVP:
//   * Git: alterações sem commit / commits sem push no workspace da conversa.
//   * Logs: erros recorrentes (via ErrorDigest).
// A execução do git roda no MESMO sandbox das ferramentas (execInSandbox), então
// só observa o que o usuário já autorizou naquele workspace.
import { execInActiveSandbox } from '../sandbox.js';
import { ErrorDigest } from './errorDigest.js';
import { createEvent, createEventOnce, hasOpenEvent } from './events.js';

// Modos em que o Companion pode intervir de forma proativa (seção 5).
export function proactiveAllowed(settings) {
  return !!settings?.enabled && settings?.proactiveAlerts !== false
    && ['auxiliar', 'proativo'].includes(settings?.mode);
}

// ---- Git -------------------------------------------------------------------

// Faz o parse do `git status --porcelain=v1 -b` em um resumo estruturado.
// Função PURA (testável) — separa a interpretação da execução no container.
export function parseGitStatus(output) {
  const lines = String(output || '').split('\n');
  let branch = null, ahead = 0, behind = 0, isRepo = true;
  const changed = [];
  const joined = lines.join('\n');
  // git fora de um repositório: mensagem em stderr/stdout.
  if (/not a git repository|fatal:\s/i.test(joined) && !lines.some(l => l.startsWith('## '))) {
    return { isRepo: false, branch: null, changed: [], ahead: 0, behind: 0, dirty: false };
  }
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      branch = head.split(/\.\.\.|\s/)[0] || null;
      const a = head.match(/ahead (\d+)/); if (a) ahead = Number(a[1]);
      const b = head.match(/behind (\d+)/); if (b) behind = Number(b[1]);
      continue;
    }
    // linhas XY <path>
    const path = line.slice(3).trim();
    if (path) changed.push(path);
  }
  return { isRepo, branch, changed, ahead, behind, dirty: changed.length > 0 };
}

// Roda o git no sandbox da conversa e devolve o resumo. OBSERVA, não cria:
// se a conversa não tem um sandbox JÁ ativo, não há o que monitorar — e
// materializar um container a cada ciclo de polling (90 s) viraria churn de
// recursos na VPS, além de poder derrubar um sandbox ativo de política
// diferente (ver execInActiveSandbox). Nunca lança: em caso de erro/sandbox
// indisponível, devolve isRepo:false.
export async function inspectGit(conversationId) {
  try {
    const cmd = 'git status --porcelain=v1 -b 2>&1 | head -400';
    const res = await execInActiveSandbox(conversationId, cmd, 20000);
    if (!res) return { isRepo: false, branch: null, changed: [], ahead: 0, behind: 0, dirty: false, noSandbox: true };
    return parseGitStatus(res.output || '');
  } catch {
    return { isRepo: false, branch: null, changed: [], ahead: 0, behind: 0, dirty: false };
  }
}

// Verifica o git e, quando fizer sentido, cria (uma única vez) o alerta de
// "trabalho sem commit / sem push". Devolve { status, event }.
export async function checkGit(userId, conversationId, { settings, project } = {}) {
  const status = await inspectGit(conversationId);
  if (!status.isRepo) return { status, event: null };
  const projectKey = project || conversationId;
  let event = null;

  if (status.dirty) {
    if (proactiveAllowed(settings)) {
      const n = status.changed.length;
      event = await createEventOnce(userId, {
        kind: 'sem_commit',
        level: 'info',
        title: `${n} arquivo${n > 1 ? 's' : ''} alterado${n > 1 ? 's' : ''} sem commit`,
        detail: `No branch ${status.branch || 'atual'}: ${status.changed.slice(0, 8).join(', ')}${n > 8 ? '…' : ''}.`,
        origin: 'monitor_git',
        project: projectKey,
        proposedAction: 'Posso revisar as mudanças e preparar um commit para você aprovar.',
        authorization: 'Nível 2 — preparar ação',
      });
    }
  } else if (status.ahead > 0 && proactiveAllowed(settings)) {
    // Sem alterações locais, mas há commits não enviados.
    if (!(await hasOpenEvent(userId, 'sem_push', projectKey))) {
      event = await createEventOnce(userId, {
        kind: 'sem_push',
        level: 'info',
        title: `${status.ahead} commit${status.ahead > 1 ? 's' : ''} sem push`,
        detail: `O branch ${status.branch || 'atual'} está ${status.ahead} à frente do remoto.`,
        origin: 'monitor_git',
        project: projectKey,
        proposedAction: 'Posso enviar (push) os commits quando você autorizar.',
        authorization: 'Nível 3 — executar com confirmação',
      });
    }
  }
  return { status, event };
}

// ---- Logs / erros recorrentes ----------------------------------------------

// Um ErrorDigest por usuário, em memória (o backend é o processo de longa
// duração — o "agente" do MVP, conforme a seção 9).
const digests = new Map();
function digestFor(userId) {
  let d = digests.get(userId);
  if (!d) { d = new ErrorDigest(); digests.set(userId, d); }
  return d;
}

// Recebe linhas de log/erro, detecta recorrência e cria alertas para as
// assinaturas que cruzaram o limiar. Devolve os eventos criados.
export async function ingestLogs(userId, { source = 'app', project = null, lines = [] } = {}, { settings, nowMs } = {}) {
  const fired = digestFor(userId).add(lines, nowMs);
  if (!fired.length || !proactiveAllowed(settings)) return [];
  const events = [];
  for (const f of fired) {
    const evt = await createEvent(userId, {
      kind: 'erro_recorrente',
      level: 'aviso',
      title: `O mesmo erro apareceu ${f.count} vezes`,
      detail: f.sample,
      origin: source === 'app' ? 'monitor_logs' : `monitor_logs:${source}`,
      project,
      dataSent: `Assinatura: ${f.signature}`,
      proposedAction: 'Posso investigar a causa provável nos logs e no código.',
      authorization: 'Nível 1 — somente leitura',
    });
    events.push(evt);
  }
  return events;
}

// Exposto para testes: limpa o estado em memória.
export function _resetDigests() { digests.clear(); }
