// Agrupamento de VERSÕES do mesmo modelo (deduplicação inteligente).
// Provedores publicam variações praticamente idênticas — mesma coisa com data
// ou identificador de versão no nome ("qwen3.5-plus" / "qwen3.5-plus-2026-04-20"
// / "qwen3.5-plus-2026-02-15"). Regras:
//   1. o nome-base sai do ID normalizado (datas/sufixos de versão removidos);
//   2. só agrupa dentro do MESMO provedor e quando os METADADOS são compatíveis
//      (capacidades/contexto/preço iguais onde ambos são conhecidos — nunca
//      pelo nome visual sozinho);
//   3. a principal é o apelido sem data (aponta para a mais nova no provedor)
//      ou, na falta dele, a versão datada mais recente;
//   4. as demais ficam acessíveis em "outras versões" (nunca escondidas de vez).

// Datas/sufixos de versão no FINAL do id (aplicados em sequência):
//   -2026-04-20 | -20260420 | -2026-04 | _2026_04_20  → data completa/ano-mês
//   -0420 | -2508 | -0309                              → snapshot de 4 dígitos
//   -latest                                            → apelido explícito
const TAIL_PATTERNS = [
  /[-_.]20\d{2}([-_.]?\d{2}){0,2}$/,   // ano[-mês[-dia]]
  /[-_.]\d{4}$/,                        // snapshot curto (aamm/mmdd)
  /[-_.]latest$/i
];

// Nome-base do modelo: minúsculo, sem o vendor ("qwen/" ou "p1::"), sem os
// sufixos de versão acima (aplicados repetidamente: "x-2026-04-20" → "x").
export function baseModelKey(id) {
  let s = String(id || '').toLowerCase().trim();
  const sep = s.indexOf('::');
  if (sep >= 0) s = s.slice(sep + 2);
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  let previous = null;
  while (previous !== s) {
    previous = s;
    for (const re of TAIL_PATTERNS) s = s.replace(re, '');
  }
  return s.replace(/[-_.]+$/, '');
}

// A remoção mudou algo? (ou seja: o id carrega data/sufixo de versão)
export function hasVersionSuffix(id) {
  let s = String(id || '').toLowerCase().trim();
  const sep = s.indexOf('::');
  if (sep >= 0) s = s.slice(sep + 2);
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  return baseModelKey(id) !== s.replace(/[-_.]+$/, '');
}

// Data aproximada de versão para ordenar (AAAAMMDD numérico); 0 se não houver.
export function versionStamp(model) {
  const id = String(model?.providerModelId || model?.id || '');
  const full = /20(\d{2})[-_.]?(\d{2})(?:[-_.]?(\d{2}))?(?=[^0-9]|$)/.exec(id);
  if (full) return Number(`20${full[1]}${full[2]}${full[3] || '00'}`);
  const shortTail = /[-_.](\d{4})$/.exec(id);
  if (shortTail) {
    const yymm = shortTail[1];
    const yy = Number(yymm.slice(0, 2));
    const mm = Number(yymm.slice(2));
    // aamm plausível (ex.: 2508 = 2025-08) — senão trata como mmdd sem ano.
    if (yy >= 20 && yy <= 39 && mm >= 1 && mm <= 12) return Number(`20${yymm}00`);
    return Number(yymm);
  }
  return Number(model?.created || 0);
}

// Metadados "compatíveis": iguais onde AMBOS são conhecidos. Desconhecido
// (null/0/'') casa com qualquer coisa — versões datadas quase nunca repetem
// todos os metadados. Diferença REAL de capacidade/contexto/preço/gratuidade
// impede o agrupamento (modelos distintos não podem ser mesclados).
const CAPS = ['text', 'tools', 'vision', 'image', 'reasoning', 'video', 'audio', 'web', 'code', 'embeddings'];
export function metadataCompatible(a, b) {
  const capA = a?.capabilities || {}, capB = b?.capabilities || {};
  for (const k of CAPS) {
    const va = capA[k], vb = capB[k];
    if ((va === true || va === false) && (vb === true || vb === false) && va !== vb) return false;
  }
  const numDiff = (x, y) => Number(x) > 0 && Number(y) > 0 && Number(x) !== Number(y);
  if (numDiff(a?.context, b?.context)) return false;
  if (a?.pricingKnown && b?.pricingKnown && (numDiff(a?.price, b?.price) || numDiff(a?.priceOut, b?.priceOut))) return false;
  if (a?.free === true && b?.free === false) return false;
  if (a?.free === false && b?.free === true) return false;
  return true;
}

// Agrupa a lista (já filtrada/ordenada) em versões. Devolve uma nova lista na
// MESMA ordem dos principais, cada principal podendo carregar `versions`
// (array das versões anteriores, mais novas primeiro).
export function groupModelVersions(models = []) {
  const byGroup = new Map(); // `${providerId}::${base}` -> índices
  const list = models || [];
  list.forEach((model, index) => {
    const key = `${model?.providerId || ''}::${baseModelKey(model?.providerModelId || model?.id)}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(index);
  });

  const consumed = new Set();
  const out = [];
  for (let idx = 0; idx < list.length; idx++) {
    const model = list[idx];
    if (consumed.has(idx)) continue;
    const key = `${model?.providerId || ''}::${baseModelKey(model?.providerModelId || model?.id)}`;
    const memberIdxs = byGroup.get(key) || [idx];
    // Só agrupa quando: 2+, pelo menos um com sufixo de versão, e TODOS os
    // metadados compatíveis com o primeiro (senão cada um segue sozinho).
    const members = memberIdxs.map(i => list[i]);
    const groupable = members.length > 1
      && members.some(m => hasVersionSuffix(m.providerModelId || m.id))
      && members.every(m => metadataCompatible(members[0], m));
    if (!groupable) { out.push(model); continue; }

    // Principal: apelido SEM sufixo de versão (aponta para a mais nova no
    // provedor); na falta, a versão de data/registro mais recente.
    const undated = members.filter(m => !hasVersionSuffix(m.providerModelId || m.id));
    const byRecency = [...members].sort((a, b) => versionStamp(b) - versionStamp(a));
    const principal = undated[0] || byRecency[0];
    const versions = byRecency.filter(m => m.id !== principal.id);
    memberIdxs.forEach(i => consumed.add(i));
    out.push(versions.length ? { ...principal, versions } : principal);
  }
  return out;
}
