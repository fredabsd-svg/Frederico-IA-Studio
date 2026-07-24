// Base de incidentes — a memória técnica persistente do copiloto (seções 12 e
// 18). Registra problema/causa/solução por projeto e CORRELACIONA um erro novo
// com os anteriores pela assinatura normalizada (mesma do errorDigest), para
// habilitar "esse erro já ocorreu antes" sem depender da memória da conversa.
import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { signatureOf } from './errorDigest.js';
import { analyzeBug } from './bugAnalysis.js';

const SEVERITY = ['info', 'baixa', 'media', 'alta', 'critica'];
const STATUS = ['aberto', 'investigando', 'resolvido', 'reaberto', 'ignorado'];
const KIND = ['bug', 'erro_recorrente', 'build', 'teste', 'dependencia', 'seguranca', 'desempenho'];

const str = (v, max = 8000) => (v == null ? null : String(v).slice(0, max));
const pick = (v, allowed, fb) => (allowed.includes(v) ? v : fb);
const jsonOrNull = (v) => { try { return v == null ? null : JSON.stringify(v); } catch { return null; } };
const clampPct = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null; };

function serialize(r) {
  if (!r) return null;
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return {
    id: r.id, project: r.project, environment: r.environment, service: r.service,
    kind: r.kind, severity: r.severity, signature: r.signature, summary: r.summary,
    errorMessage: r.error_message, stack: r.stack, probableCause: r.probable_cause,
    relatedFiles: parse(r.related_files), recentChanges: parse(r.recent_changes),
    suggestedFix: r.suggested_fix, commands: parse(r.commands), evidence: parse(r.evidence),
    confidence: r.confidence, status: r.status, solution: r.solution, result: r.result,
    commitRef: r.commit_ref, prRef: r.pr_ref, occurrences: r.occurrences,
    firstSeen: r.first_seen, lastSeen: r.last_seen, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// A assinatura de correlação: usa a fornecida, ou deriva de errorMessage/summary.
export function incidentSignature(input = {}) {
  return input.signature || signatureOf(input.errorMessage || input.summary || '');
}

// Incidentes anteriores do MESMO problema (mesma assinatura), no projeto.
export async function findSimilar(userId, { signature, project = null, excludeId = null, limit = 5 } = {}) {
  if (!signature) return [];
  const rows = project
    ? await db.prepare(`SELECT * FROM companion_incidents WHERE user_id=? AND signature=? AND project IS NOT DISTINCT FROM ? ORDER BY last_seen DESC LIMIT ?`).all(userId, signature, project, limit + 1)
    : await db.prepare(`SELECT * FROM companion_incidents WHERE user_id=? AND signature=? ORDER BY last_seen DESC LIMIT ?`).all(userId, signature, limit + 1);
  return rows.filter(r => r.id !== excludeId).slice(0, limit).map(serialize);
}

// Registra um incidente. Se já existir um ABERTO com a mesma assinatura/projeto,
// incrementa as ocorrências e atualiza last_seen (correlação) em vez de duplicar.
// Devolve { incident, recurring, previous } — `previous` são ocorrências passadas.
export async function recordIncident(userId, data = {}) {
  const signature = incidentSignature(data);
  const project = data.project ?? null;
  const t = now();

  const existing = signature
    ? await db.prepare(`SELECT * FROM companion_incidents WHERE user_id=? AND signature=? AND project IS NOT DISTINCT FROM ? AND status IN ('aberto','investigando','reaberto') ORDER BY last_seen DESC LIMIT 1`).get(userId, signature, project)
    : null;

  if (existing) {
    await db.prepare('UPDATE companion_incidents SET occurrences=occurrences+1, last_seen=?, updated_at=? WHERE id=?')
      .run(t, t, existing.id);
    const incident = serialize(await db.prepare('SELECT * FROM companion_incidents WHERE id=?').get(existing.id));
    const previous = await findSimilar(userId, { signature, project, excludeId: existing.id });
    return { incident, recurring: true, previous };
  }

  // Auto-análise (pura): preenche causa/arquivos/severidade/confiança quando não
  // vieram prontos — sempre com base em evidência (mensagem/stack), nunca chute.
  const analysis = (data.errorMessage || data.stack) ? analyzeBug({ errorMessage: data.errorMessage, stack: data.stack }) : null;
  const severity = pick(data.severity, SEVERITY, analysis?.severity || 'media');
  const probableCause = data.probableCause || analysis?.probableCause || null;
  const relatedFiles = data.relatedFiles || analysis?.files || null;
  const confidence = clampPct(data.confidence != null ? data.confidence : analysis?.confidence);

  const id = nanoid();
  await db.prepare(
    `INSERT INTO companion_incidents
     (id,user_id,project,environment,service,kind,severity,signature,summary,error_message,stack,
      probable_cause,related_files,recent_changes,suggested_fix,commands,evidence,confidence,status,
      solution,result,commit_ref,pr_ref,occurrences,first_seen,last_seen,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, userId, project, str(data.environment, 60), str(data.service, 120),
    pick(data.kind, KIND, 'bug'), severity, signature || null,
    str(data.summary, 500) || 'Incidente sem resumo', str(data.errorMessage), str(data.stack),
    str(probableCause, 2000), jsonOrNull(relatedFiles), jsonOrNull(data.recentChanges),
    str(data.suggestedFix, 2000), jsonOrNull(data.commands), jsonOrNull(data.evidence), confidence,
    pick(data.status, STATUS, 'aberto'), str(data.solution, 2000), str(data.result, 2000),
    str(data.commitRef, 80), str(data.prRef, 120), 1, t, t, t, t,
  );
  const incident = serialize(await db.prepare('SELECT * FROM companion_incidents WHERE id=?').get(id));
  const previous = await findSimilar(userId, { signature, project, excludeId: id });
  return { incident, recurring: false, previous };
}

export async function listIncidents(userId, { project = null, status = null, limit = 100 } = {}) {
  const clauses = ['user_id=?']; const params = [userId];
  if (project) { clauses.push('project=?'); params.push(project); }
  if (status) { clauses.push('status=?'); params.push(status); }
  params.push(Math.min(500, limit));
  const rows = await db.prepare(`SELECT * FROM companion_incidents WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params);
  return rows.map(serialize);
}

export async function getIncident(userId, id) {
  return serialize(await db.prepare('SELECT * FROM companion_incidents WHERE id=? AND user_id=?').get(id, userId));
}

// Atualiza status/solução/resultado (ciclo de vida do incidente).
export async function updateIncident(userId, id, patch = {}) {
  const cur = await db.prepare('SELECT * FROM companion_incidents WHERE id=? AND user_id=?').get(id, userId);
  if (!cur) return null;
  const status = patch.status ? pick(patch.status, STATUS, cur.status) : cur.status;
  await db.prepare('UPDATE companion_incidents SET status=?, solution=COALESCE(?,solution), result=COALESCE(?,result), probable_cause=COALESCE(?,probable_cause), commit_ref=COALESCE(?,commit_ref), pr_ref=COALESCE(?,pr_ref), updated_at=? WHERE id=? AND user_id=?')
    .run(status, str(patch.solution, 2000), str(patch.result, 2000), str(patch.probableCause, 2000), str(patch.commitRef, 80), str(patch.prRef, 120), now(), id, userId);
  return getIncident(userId, id);
}

export { serialize as serializeIncident };
