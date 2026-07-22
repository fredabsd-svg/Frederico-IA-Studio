// Sincronização do catálogo de modelos (Fase 2): compara o catálogo salvo com o
// que o provedor devolve agora, detecta o que mudou (novos, removidos, preço,
// contexto, capacidades, status, IDs), MESCLA preservando o dado bom (nunca
// sobrescreve informação válida com vazio da API) e registra o histórico.
//
// As funções de diff/merge são PURAS e testáveis. O orquestrador runProviderSync
// junta tudo com a API do provedor e o banco, e é usado tanto pela rotina diária
// quanto pelo botão de atualização manual.
import { db, now } from './db.js';
import { decryptSecret } from './crypto.js';
import { enrichProviderCatalog, importProviderCatalog } from './providerCatalog.js';
import { modelProfileFromProvider } from './modelCapabilities.js';

const CAP_KEYS = ['text', 'tools', 'vision', 'image', 'reasoning', 'video', 'audio', 'web', 'files', 'code', 'embeddings'];
// Campos escalares do PERFIL (já enriquecido) que vale a pena vigiar.
const WATCH_FIELDS = ['context', 'maxOutput', 'price', 'priceOut', 'status', 'tier'];

const str = v => String(v ?? '').trim();
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const hasPricing = m => Number.isFinite(Number(m?.pricing?.prompt)) || Number.isFinite(Number(m?.pricing?.completion));

// Mescla o catálogo novo (verdade atual) preservando o que a API deixou de
// mandar: nome, contexto, saída máxima, preço, arquitetura e supported_parameters
// herdam do catálogo anterior quando o novo vier vazio. Assim uma resposta
// incompleta da API não "apaga" dado bom que já tínhamos.
export function mergePreserving(oldModels = [], newModels = []) {
  const prevById = new Map((oldModels || []).map(m => [str(m.id), m]));
  return (newModels || []).map(fresh => {
    const prev = prevById.get(str(fresh.id));
    if (!prev) return fresh;
    const merged = { ...fresh };
    if (!str(merged.name) && str(prev.name)) merged.name = prev.name;
    if (!num(merged.context_length) && num(prev.context_length)) merged.context_length = prev.context_length;
    if (!num(merged.max_output_tokens) && num(prev.max_output_tokens)) merged.max_output_tokens = prev.max_output_tokens;
    if (!hasPricing(merged) && hasPricing(prev)) merged.pricing = prev.pricing;
    if (!merged.architecture && prev.architecture) merged.architecture = prev.architecture;
    if ((!Array.isArray(merged.supported_parameters) || !merged.supported_parameters.length)
        && Array.isArray(prev.supported_parameters) && prev.supported_parameters.length) {
      merged.supported_parameters = prev.supported_parameters;
    }
    return merged;
  });
}

function profilesById(models, providerType) {
  const map = new Map();
  for (const raw of enrichProviderCatalog(models || [], providerType)) {
    map.set(str(raw.id), modelProfileFromProvider(raw));
  }
  return map;
}

function findDuplicates(models = []) {
  const seen = new Set();
  const dups = new Set();
  for (const m of models) { const id = str(m.id); if (seen.has(id)) dups.add(id); else seen.add(id); }
  return [...dups];
}

// Compara dois catálogos (perfis ENRIQUECIDOS) e devolve o checklist completo:
// adicionados, removidos, alterados (campo a campo, com antes/depois), duplicados
// e cadastros incompletos (sem preço ou sem contexto).
export function diffCatalog(oldModels = [], newModels = [], providerType = 'custom') {
  const A = profilesById(oldModels, providerType);
  const B = profilesById(newModels, providerType);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, pb] of B) if (!A.has(id)) added.push({ id, name: pb.name });
  for (const [id, pa] of A) if (!B.has(id)) removed.push({ id, name: pa.name });
  for (const [id, pb] of B) {
    const pa = A.get(id);
    if (!pa) continue;
    for (const f of WATCH_FIELDS) {
      if (str(pa[f]) !== str(pb[f])) changed.push({ id, name: pb.name, field: f, from: pa[f] ?? null, to: pb[f] ?? null, source: pb.metadataSource });
    }
    for (const c of CAP_KEYS) {
      if ((pa.capabilities?.[c] ?? null) !== (pb.capabilities?.[c] ?? null)) {
        changed.push({ id, name: pb.name, field: `capabilities.${c}`, from: pa.capabilities?.[c] ?? null, to: pb.capabilities?.[c] ?? null, source: pb.metadataSource });
      }
    }
  }
  const incomplete = [...B.values()].filter(p => !p.pricingKnown || !p.context).map(p => ({ id: p.id, name: p.name }));
  const deprecated = [...B.values()].filter(p => p.status && p.status !== 'active').map(p => ({ id: p.id, name: p.name, status: p.status, replacement: p.replacement || null }));
  return {
    added, removed, changed,
    duplicates: findDuplicates(newModels),
    incomplete, deprecated,
    counts: { added: added.length, removed: removed.length, changed: changed.length, incomplete: incomplete.length, deprecated: deprecated.length }
  };
}

async function recordHistory(userId, providerId, providerName, report) {
  const t = now();
  const rows = [];
  for (const a of report.added) rows.push([userId, providerId, providerName, a.id, 'added', null, null, str(a.name), 'provider_api', t]);
  for (const r of report.removed) rows.push([userId, providerId, providerName, r.id, 'removed', null, str(r.name), null, 'provider_api', t]);
  for (const c of report.changed) rows.push([userId, providerId, providerName, c.id, 'changed', c.field, str(c.from), str(c.to), c.source || 'provider_api', t]);
  // Limita a gravação por sync para não inflar o histórico numa primeira carga.
  for (const r of rows.slice(0, 500)) {
    await db.prepare(`INSERT INTO model_catalog_history
      (user_id,provider_id,provider_name,model_id,change_type,field,old_value,new_value,source,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...r).catch(() => {});
  }
  return rows.length;
}

// Orquestra a sincronização de UM provedor: importa fresco, mescla preservando,
// diffa, persiste e registra histórico. Devolve o relatório para a interface.
// `automatic` controla se o fallback de validação por chat é permitido (na
// rotina diária, não fazemos chamadas pagas de chat).
export async function runProviderSync(row, { automatic = true } = {}) {
  const providerLabel = row.name || row.provider_type;
  const apiKey = decryptSecret(row.api_key_enc);
  if (!apiKey) return { provider: providerLabel, ok: false, error: 'Sem chave para este provedor.' };
  const oldModels = (() => { try { const d = JSON.parse(row.models || '[]'); return Array.isArray(d) ? d : []; } catch { return []; } })();
  try {
    const imported = await importProviderCatalog({
      apiKey, baseURL: row.base_url, providerType: row.provider_type,
      modelHint: row.default_model, allowModelValidation: !automatic
    });
    const merged = mergePreserving(oldModels, imported.models);
    const report = diffCatalog(oldModels, merged, row.provider_type);
    const t = now();
    await db.prepare('UPDATE user_ai_providers SET models=?,last_validated_at=?,updated_at=?,last_sync_status=?,last_sync_error=? WHERE id=? AND user_id=?')
      .run(JSON.stringify(merged), t, t, 'ok', null, row.id, row.user_id);
    const recorded = await recordHistory(row.user_id, row.id, providerLabel, report);
    return { provider: providerLabel, providerId: row.id, ok: true, total: merged.length, ...report, recorded };
  } catch (error) {
    await db.prepare('UPDATE user_ai_providers SET last_sync_status=?,last_sync_error=?,updated_at=? WHERE id=? AND user_id=?')
      .run('error', String(error?.message || '').slice(0, 300), now(), row.id, row.user_id).catch(() => {});
    return { provider: providerLabel, providerId: row.id, ok: false, error: String(error?.message || 'Falha ao atualizar.').slice(0, 300) };
  }
}

// Sincroniza todos os provedores de um usuário (botão manual). Um provedor com
// erro não derruba os demais.
export async function runUserSync(userId, { automatic = false } = {}) {
  const rows = await db.prepare('SELECT * FROM user_ai_providers WHERE user_id=? ORDER BY created_at ASC').all(userId).catch(() => []);
  const results = [];
  for (const row of rows) results.push(await runProviderSync(row, { automatic }));
  return results;
}

// Rotina DIÁRIA: percorre todos os provedores de todos os usuários. Não faz
// chamadas de chat (automatic=true). Silenciosa por natureza; loga só o resumo.
export async function runDailyCatalogSync() {
  const rows = await db.prepare('SELECT * FROM user_ai_providers ORDER BY created_at ASC').all().catch(() => []);
  let ok = 0, failed = 0, changes = 0;
  for (const row of rows) {
    const r = await runProviderSync(row, { automatic: true });
    if (r.ok) { ok += 1; changes += (r.counts?.added || 0) + (r.counts?.removed || 0) + (r.counts?.changed || 0); }
    else failed += 1;
  }
  console.log(`[catálogo] sync diário: ${ok} provedor(es) ok, ${failed} com erro, ${changes} mudança(s) registrada(s).`);
  return { providers: rows.length, ok, failed, changes };
}
