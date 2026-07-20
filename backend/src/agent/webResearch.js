// Pesquisa na web durante o loop agêntico: limites de busca, normalização de
// URL, classificação do resultado das ferramentas e planejamento do lote de
// chamadas de ferramenta por etapa.
// Extraído de agent.js (refatoração mecânica, sem mudança de comportamento).

const WEB_RESEARCH_FAILURE_LIMIT = Math.max(1, Number(process.env.WEB_RESEARCH_FAILURE_LIMIT || 3));
export const WEB_RESEARCH_FETCH_LIMIT = Math.max(1, Number(process.env.WEB_RESEARCH_FETCH_LIMIT || 8));
export const TOOL_CALLS_PER_STEP_LIMIT = Math.max(1, Number(process.env.TOOL_CALLS_PER_STEP_LIMIT || 12));

export function normalizeWebFetchUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    return url.toString();
  } catch {
    return String(value || '').trim();
  }
}

export function classifyToolOutcome(name, result) {
  let payload = null;
  try { payload = JSON.parse(result); } catch { return { failed: false, recoverable: false, detail: '', webUnavailable: false }; }
  if (!payload || typeof payload !== 'object') return { failed: false, recoverable: false, detail: '', webUnavailable: false };

  const status = Number(payload.status);
  const httpFailure = Number.isInteger(status) && (status < 200 || status >= 300);
  const hasError = Boolean(payload.error) || (typeof payload.exitCode === 'number' && payload.exitCode !== 0);
  const unreadableFetch = name === 'web_fetch' && (!String(payload.content || '').trim() || Boolean(payload.note));
  const failed = hasError || (name === 'web_fetch' && (httpFailure || unreadableFetch));
  const emptySearch = name === 'web_search' && Array.isArray(payload.results) && payload.results.length === 0;
  const detail = String(payload.error || payload.output || (httpFailure ? `HTTP ${status}` : '') || '').slice(-300);

  return {
    failed,
    recoverable: failed && Boolean(payload.recoverable),
    detail,
    webUnavailable: (name === 'web_fetch' && failed) || emptySearch
  };
}

export function webResearchStopReason({ repeatedFetch = false, unavailableSources = 0, fetchAttempts = 0, failureLimit = WEB_RESEARCH_FAILURE_LIMIT, fetchLimit = WEB_RESEARCH_FETCH_LIMIT } = {}) {
  if (repeatedFetch) return 'a mesma fonte já foi consultada nesta tarefa';
  if (unavailableSources >= failureLimit) return `${unavailableSources} fontes não retornaram conteúdo utilizável`;
  if (fetchAttempts >= fetchLimit) return `o limite de ${fetchLimit} páginas consultadas foi alcançado`;
  return null;
}

export function planToolCallBatch(calls, seenWebFetches = new Set(), maxCalls = TOOL_CALLS_PER_STEP_LIMIT, maxWebFetches = Infinity) {
  const planned = [];
  const urlsInBatch = new Set(seenWebFetches);
  let webStopReason = '';
  let truncated = false;
  let plannedWebFetches = 0;

  for (const call of calls || []) {
    if (planned.length >= maxCalls) {
      truncated = true;
      break;
    }
    const name = call?.function?.name;
    let rawUrl = '';
    if (name === 'web_fetch') {
      try { rawUrl = JSON.parse(call?.function?.arguments || '{}').url || ''; } catch {}
    }
    const url = name === 'web_fetch' ? normalizeWebFetchUrl(rawUrl) : '';
    if (name === 'web_fetch' && url && urlsInBatch.has(url)) {
      webStopReason = webResearchStopReason({ repeatedFetch: true });
      break;
    }
    if (name === 'web_fetch' && url && plannedWebFetches >= maxWebFetches) {
      webStopReason = webResearchStopReason({ fetchAttempts: WEB_RESEARCH_FETCH_LIMIT });
      break;
    }
    if (name === 'web_fetch' && url) urlsInBatch.add(url);
    if (name === 'web_fetch' && url) plannedWebFetches += 1;
    planned.push(call);
  }

  return { calls: planned, webStopReason, truncated };
}

// Ferramentas de PESQUISA na web. Ao encerrar a pesquisa, removemos SÓ estas —
// nunca as de gerar arquivo (run_python, write_file...). Antes, o app zerava
// TODAS as ferramentas ao atingir o limite de busca, então o modelo ficava sem
// run_python e não conseguia gerar o Word/Excel/PDF pedido (dizia "não tenho
// ferramenta de execução de código"). Este era o bug real dos relatórios de CNPJ.
export const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);

export function webResearchFinalizationNote(reason) {
  return `A PESQUISA NA WEB foi encerrada (${reason}) — não faça novas buscas. Isso NÃO encerra a tarefa: as demais ferramentas continuam disponíveis. Se o pedido é um arquivo (Word/Excel/PDF), GERE o arquivo agora com run_python usando os dados que você já obteve (ex.: o extrato do CNPJ e o que apareceu nas buscas) e salve em /workspace/outputs. Cite as fontes e diga com franqueza o nível de confiança; não invente dados ausentes. Só responda apenas em texto se o pedido não exigia arquivo.`;
}
