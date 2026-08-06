// Agrega o conjunto de runs (um por cenário × modo) em veredito final.
//
// VEREDITOS POSSÍVEIS
//   'native_supported'   — provider entregou tool_calls estruturados em ≥80% dos
//                           cenários que exigiam tool_call.
//   'text_only'          — modelo respondeu em texto puro mesmo quando a tool
//                           estava disponível em 100% dos cenários que exigiam
//                           tool_call.
//   'json_block'         — modelo emitiu ```json {...} ``` quando instruído,
//                           mas provider não estruturou.
//   'xml_block'          — modelo emitiu <tool_call>...</tool_call> quando
//                           instruído, mas provider não estruturou.
//   'unreliable'         — modelo ora chama, ora não chama; argumentos divergem
//                           mais que o tolerável. Frente precisa decidir.
//   'no_capability'      — provider retornou erro ou refutou ferramentas.
//
// Estes rótulos descrevem o "melhor caminho" para a próxima frente, NÃO uma
// aprovação/reprovação moral. Mesmo 'unreliable' pode ser viável com prompt
// reforçado — só não cabe nesta frente decidir.

const NATIVE_THRESHOLD = 0.8; // ≥80% dos runs nativos
const TEXT_ONLY_THRESHOLD = 1.0; // 100% (precisa ser claro)

export function aggregateRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      verdict: 'no_capability',
      reason: 'nenhum run foi executado',
      perScenario: [],
      perMode: { withTools: null, withoutTools: null },
      totals: { runs: 0, matches: 0, toolCalls: 0, malformed: 0 },
    };
  }

  const perScenario = runs.map((run) => ({
    scenarioId: run.scenarioId,
    mode: run.mode ?? null,
    turn: run.turn ?? null,
    expectedDecision: run.expectedDecision,
    decision: run.classified?.decision ?? 'unknown',
    parseSource: run.classified?.parseSource ?? 'unknown',
    match: run.match,
    matchReason: run.matchReason,
    toolName: run.classified?.toolName ?? null,
    arguments: run.classified?.arguments ?? null,
    durationMs: run.durationMs ?? null,
    providerError: run.providerError ?? null,
  }));

  const withTools = runs.filter((r) => r.mode === 'with_tools');
  const withoutTools = runs.filter((r) => r.mode === 'without_tools');

  // Modo sem tools é CONTROLE: modelo não deveria conseguir chamar tools
  // estruturadas (provider não recebe schemas). Não influencia o veredito
  // principal, mas vai para o relatório como sanity check.
  const modeStats = (arr) => {
    if (arr.length === 0) return null;
    const toolCalls = arr.filter((r) => r.classified?.decision === 'tool_call');
    const malformed = arr.filter((r) => r.classified?.decision === 'malformed');
    const matches = arr.filter((r) => r.match).length;
    return {
      total: arr.length,
      toolCalls: toolCalls.length,
      malformed: malformed.length,
      matches,
      matchRate: matches / arr.length,
      parseSources: arr.reduce((acc, r) => {
        const src = r.classified?.parseSource ?? 'unknown';
        acc[src] = (acc[src] ?? 0) + 1;
        return acc;
      }, {}),
    };
  };

  const perMode = {
    withTools: modeStats(withTools),
    withoutTools: modeStats(withoutTools),
  };

  const verdict = computeVerdict(perMode, withTools, runs);

  return {
    verdict: verdict.verdict,
    reason: verdict.reason,
    perScenario,
    perMode,
    totals: {
      runs: runs.length,
      matches: runs.filter((r) => r.match).length,
      toolCalls: runs.filter((r) => r.classified?.decision === 'tool_call').length,
      malformed: runs.filter((r) => r.classified?.decision === 'malformed').length,
    },
  };
}

function computeVerdict(perMode, withTools, allRuns) {
  if (withTools.length === 0) {
    return { verdict: 'no_capability', reason: 'nenhum run com tools foi executado' };
  }

  // Erros do provider: se mais da metade falhou, o veredito é 'no_capability'.
  const providerErrors = withTools.filter((r) => Boolean(r.providerError));
  if (providerErrors.length / withTools.length > 0.5) {
    return {
      verdict: 'no_capability',
      reason: `${providerErrors.length}/${withTools.length} runs com tools falharam no provider`,
    };
  }

  // Fonte do parse no modo com_tools:
  const sources = perMode.withTools.parseSources ?? {};
  const native = sources.native ?? 0;
  const jsonBlock = sources.json_block ?? 0;
  const xmlBlock = sources.xml_block ?? 0;
  const fallback = sources.fallback ?? 0;
  const totalWithTools = perMode.withTools.total;
  const nativeRate = native / totalWithTools;

  if (nativeRate >= NATIVE_THRESHOLD) {
    return {
      verdict: 'native_supported',
      reason: `${native}/${totalWithTools} runs com tools (${(nativeRate * 100).toFixed(0)}%) retornaram tool_calls nativos — provider entrega structured tool calling`,
    };
  }

  if (fallback === totalWithTools) {
    // Nenhuma tool foi emitida: modelo ignorou as tools disponíveis.
    return {
      verdict: 'text_only',
      reason: `${fallback}/${totalWithTools} runs com tools ficaram em texto puro — modelo não emite tool calls mesmo quando instruído`,
    };
  }

  if (jsonBlock >= xmlBlock && jsonBlock > 0) {
    return {
      verdict: 'json_block',
      reason: "modelo emite ```json { ... }``` quando instruído (" + jsonBlock + "/" + totalWithTools + ") — parser dedicado é viável",
    };
  }

  if (xmlBlock > 0) {
    return {
      verdict: 'xml_block',
      reason: `modelo emite <tool_call>...</tool_call> quando instruído (${xmlBlock}/${totalWithTools}) — parser dedicado é viável`,
    };
  }

  // Mistura sem padrão claro: algumas tool_calls, algumas não, alguns malformed.
  return {
    verdict: 'unreliable',
    reason: `respostas sem padrão consistente: native=${native}, json_block=${jsonBlock}, xml_block=${xmlBlock}, fallback=${fallback} em ${totalWithTools} runs`,
  };
}

// Serializa o veredito para JSON puro (sem campos null/undefined que confundem
// diffs em PRs). Usado pelo CLI e pelo endpoint.
export function toJSON(result) {
  return JSON.parse(JSON.stringify(result));
}

// Renderiza um relatório curto em Markdown (para colar no PR / Slack).
export function toMarkdown(result) {
  const lines = [];
  lines.push(`# Tool calling probe — veredito`);
  lines.push('');
  lines.push(`- **Veredito**: \`${result.verdict}\``);
  lines.push(`- **Motivo**: ${result.reason}`);
  lines.push(`- **Runs**: ${result.totals.runs} total, ${result.totals.matches} match, ${result.totals.toolCalls} tool_call, ${result.totals.malformed} malformed`);
  lines.push('');
  lines.push('## Por modo');
  lines.push('');
  lines.push('| mode | total | tool_calls | malformed | matches | match_rate |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const mode of ['withTools', 'withoutTools']) {
    const m = result.perMode[mode];
    if (!m) {
      lines.push(`| ${mode} | 0 | 0 | 0 | 0 | — |`);
      continue;
    }
    lines.push(
      `| ${mode} | ${m.total} | ${m.toolCalls} | ${m.malformed} | ${m.matches} | ${(m.matchRate * 100).toFixed(0)}% |`
    );
  }
  lines.push('');
  lines.push('## Por cenário');
  lines.push('');
  lines.push('| cenário | esperado | decisão | source | match |');
  lines.push('|---|---|---|---|---|');
  for (const s of result.perScenario) {
    lines.push(
      `| ${s.scenarioId} | ${s.expectedDecision} | ${s.decision} | ${s.parseSource} | ${s.match ? '✅' : '❌'} |`
    );
  }
  return lines.join('\n');
}