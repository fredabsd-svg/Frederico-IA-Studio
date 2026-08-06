#!/usr/bin/env node
// CLI da sonda de tool calling.
//
// Uso:
//   node scripts/run-tool-probe.mjs                     # dry-run, sem rede
//   node scripts/run-tool-probe.mjs --live              # chama provider real
//   node scripts/run-tool-probe.mjs --out result.json   # grava JSON
//   node scripts/run-tool-probe.mjs --md  report.md     # grava Markdown
//   node scripts/run-tool-probe.mjs --only math.simple_addition
//
// Sem --live, é seguro rodar em CI (custo zero, sem rede).
// Com --live, o provider real é chamado; pode custar tokens e demorar.

import { runProbeCli } from '../src/tools/probe/probeRunner.js';

const argv = process.argv.slice(2);
const live = argv.includes('--live');

// Injeta provider real se --live foi passado e o módulo carrega.
// Em ambiente sem provider.js configurado, o catch interno do runner
// captura como providerError; o veredito vira 'no_capability'.
if (live) {
  try {
    const mod = await import('../src/provider.js');
    // Substitui o argv para o CLI não tentar dryProviderCall.
    const filtered = argv.filter((a) => a !== '--live');
    const fakeProcess = { ...process, argv: ['node', 'cli', ...filtered] };
    process.env.PROBE_LIVE = '1';
    await runProbeCliWithProvider(mod, filtered);
  } catch (err) {
    console.error(`# provider não carregou: ${err?.message ?? err}`);
    console.error('# caindo em dry-run');
    await runProbeCli();
  }
} else {
  await runProbeCli();
}

async function runProbeCliWithProvider(providerMod, argvSubset) {
  const outIndex = argvSubset.indexOf('--out');
  const outPath = outIndex >= 0 ? argvSubset[outIndex + 1] : null;
  const mdIndex = argvSubset.indexOf('--md');
  const mdPath = mdIndex >= 0 ? argvSubset[mdIndex + 1] : null;
  const onlyIndex = argvSubset.indexOf('--only');
  const onlyId = onlyIndex >= 0 ? argvSubset[onlyIndex + 1] : null;

  const providerFn = async (messages, options) => {
    return await providerMod.generateOpenAICompatible({
      messages,
      model: options.model ?? process.env.DEFAULT_LLM ?? 'default',
      temperature: options.temperature ?? 0,
      maxTokens: options.maxTokens ?? 300,
      tools: options.tools,
    });
  };

  const { runProbe } = await import('../src/tools/probe/probeRunner.js');
  const { toJSON, toMarkdown } = await import('../src/tools/probe/results.js');

  const result = await runProbe({
    providerFn,
    ...(onlyId ? { scenarioIds: [onlyId] } : {}),
  });

  if (outPath) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(outPath, JSON.stringify(toJSON(result), null, 2), 'utf8');
  }
  if (mdPath) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(mdPath, toMarkdown(result), 'utf8');
  }

  console.log(`# probe veredito: ${result.verdict}`);
  console.log(`# motivo: ${result.reason}`);
  console.log(
    `# totais: ${result.totals.runs} runs / ${result.totals.matches} match / ${result.totals.toolCalls} tool_call / ${result.totals.malformed} malformed`
  );
}