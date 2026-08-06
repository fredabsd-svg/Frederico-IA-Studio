// Orquestrador da sonda: roda os cenários contra o provider e devolve runs
// brutos (um por cenário × modo × turno). O agregador (results.js) transforma
// em veredito.
//
// MODO DRY-RUN (default se provider não for injetado):
//   - Não chama LLM.
//   - Retorna 'no_tool' para todos os runs, com providerError = null.
//   - Custo: zero. Útil para CI e para verificar o pipeline.
//
// MODO REAL (provider injetado):
//   - Chama o provider com `tools` (modo with_tools) ou sem (modo without_tools).
//   - Usa generateOpenAICompatible OU o que tiver sido injetado.
//   - Timeout por run: PROBE_TIMEOUT_MS (default 30s) — falha conta como
//     providerError e vira 'malformed' no veredito.
//
// Por que não usar Promise.all?
//   - Para manter custo baixo (5 cenários × 2 modos × 3 turnos = 30 chamadas),
//     sequencial com paralelismo limitado é suficiente e mais previsível para
//     debugar. Paralelismo total arriscaria rate limit do provider.

import { setTimeout as delay } from 'node:timers/promises';
import { scenarios } from './scenarios.js';
import { classifyToolCall, compareToExpectation } from './classifier.js';
import { aggregateRuns, toJSON, toMarkdown } from './results.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TURNS = 3; // 3 turnos por (cenário × modo) para detectar inconsistência
const DEFAULT_CONCURRENCY = 2;

function nowIso() {
  return new Date().toISOString();
}

// Runner sintético (dry-run). Não toca rede.
async function dryProviderCall(_messages, _options) {
  await delay(1);
  return {
    content: '',
    tool_calls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

async function safeCall(providerFn, messages, options, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([providerFn(messages, options), timeoutPromise]);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function runOne(scenario, mode, turn, providerFn, timeoutMs) {
  const messages = [
    {
      role: 'system',
      content:
        mode === 'with_tools'
          ? 'Você tem acesso a ferramentas. Se uma tool resolver a pergunta do usuário, CHAME-A usando o formato JSON oficial.'
          : 'Responda em texto puro. Nenhuma ferramenta está disponível.',
    },
    { role: 'user', content: scenario.userMessage },
  ];

  const options = {
    model: process.env.PROBE_MODEL ?? 'probe-model',
    temperature: 0,
    maxTokens: 300,
    ...(mode === 'with_tools' ? { tools: scenario.tools } : {}),
  };

  const started = Date.now();
  const call = await safeCall(providerFn, messages, options, timeoutMs);
  const durationMs = Date.now() - started;

  if (!call.ok) {
    return {
      scenarioId: scenario.id,
      mode,
      turn,
      classified: { decision: 'malformed', parseSource: 'native', parseError: `provider error: ${call.error}` },
      match: false,
      matchReason: `provider falhou: ${call.error}`,
      durationMs,
      providerError: call.error,
      expectedDecision: scenario.expectedDecision,
      capturedAt: nowIso(),
    };
  }

  const classified = classifyToolCall(call.result);
  const cmp = compareToExpectation(classified, scenario);

  return {
    scenarioId: scenario.id,
    mode,
    turn,
    classified,
    match: cmp.match,
    matchReason: cmp.reason,
    durationMs,
    providerError: null,
    expectedDecision: scenario.expectedDecision,
    capturedAt: nowIso(),
  };
}

// Pool de execução com concorrência limitada.
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const launch = async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  };
  const launchers = Array.from({ length: Math.min(concurrency, items.length) }, launch);
  await Promise.all(launchers);
  return results;
}

// API pública.
export async function runProbe(options = {}) {
  const providerFn = options.providerFn ?? dryProviderCall;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const turns = options.turns ?? DEFAULT_TURNS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const scenarioFilter = options.scenarioIds; // opcional: restringe quais cenários rodam

  const selectedScenarios = scenarioFilter
    ? scenarios.filter((s) => scenarioFilter.includes(s.id))
    : scenarios;

  const jobs = [];
  for (const scenario of selectedScenarios) {
    for (const mode of ['with_tools', 'without_tools']) {
      for (let turn = 1; turn <= turns; turn++) {
        jobs.push({ scenario, mode, turn });
      }
    }
  }

  const runs = await runPool(jobs, concurrency, (job) =>
    runOne(job.scenario, job.mode, job.turn, providerFn, timeoutMs)
  );

  return aggregateRuns(runs);
}

// CLI-friendly: imprime resumo no stdout e devolve o agregado.
export async function runProbeCli(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run') || !process.env.PROBE_LIVE;
  const outIndex = argv.indexOf('--out');
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : null;
  const mdIndex = argv.indexOf('--md');
  const mdPath = mdIndex >= 0 ? argv[mdIndex + 1] : null;

  const result = await runProbe({
    providerFn: dryRun ? dryProviderCall : null, // null -> cai no dryRun default
  });

  if (outPath) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(outPath, JSON.stringify(toJSON(result), null, 2), 'utf8');
  }
  if (mdPath) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(mdPath, toMarkdown(result), 'utf8');
  }

  // Stdout sempre tem resumo curto.
  console.log(`# probe veredito: ${result.verdict}`);
  console.log(`# motivo: ${result.reason}`);
  console.log(
    `# totais: ${result.totals.runs} runs / ${result.totals.matches} match / ${result.totals.toolCalls} tool_call / ${result.totals.malformed} malformed`
  );

  return result;
}

export { aggregateRuns, toJSON, toMarkdown };