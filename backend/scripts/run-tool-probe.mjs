#!/usr/bin/env node
// CLI da sonda de tool calling.
//
// Uso:
//   node scripts/run-tool-probe.mjs                     # dry-run, sem rede
//   node scripts/run-tool-probe.mjs --live              # chama o provedor real
//   node scripts/run-tool-probe.mjs --out result.json   # grava JSON
//   node scripts/run-tool-probe.mjs --md  report.md     # grava Markdown
//   node scripts/run-tool-probe.mjs --only math.simple_addition
//
// Configuração do --live (nunca commite chave; use o .env ou o ambiente):
//   SONDA_API_KEY   (ou VALIDACAO_API_KEY, FREE_TIER_API_KEY)
//   SONDA_BASE_URL  (ou VALIDACAO_BASE_URL, FREE_TIER_BASE_URL, DEEPSEEK_BASE_URL)
//   SONDA_MODELO    (ou PROBE_MODEL, VALIDACAO_MODELO, DEFAULT_LLM)
//
// Sem --live, é seguro rodar em CI (custo zero, sem rede).
// Com --live, o provedor real é chamado; pode custar tokens e demorar.
//
// O `--live` NÃO cai em dry-run quando falta configuração: ele sai com código 2
// dizendo o que falta. Era o defeito antigo — o dry-run responde `no_tool` em
// todos os cenários, então a queda silenciosa imprimia "este modelo não faz
// tool calling" sem ter chamado modelo nenhum.

import { runProbe, runProbeCli } from '../src/tools/probe/probeRunner.js';
import { toJSON, toMarkdown } from '../src/tools/probe/results.js';
import { providerDoAmbiente, SondaSemProvedor } from '../src/tools/probe/provider.js';

const argv = process.argv.slice(2);
const valor = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

if (!argv.includes('--live')) {
  await runProbeCli(argv);
} else {
  let providerFn;
  try {
    providerFn = providerDoAmbiente();
  } catch (err) {
    if (!(err instanceof SondaSemProvedor)) throw err;
    console.error(`# --live pedido, mas ${err.message}.`);
    console.error('# Nada foi chamado. Configure e rode de novo (ou omita --live para o dry-run).');
    process.exit(2);
  }

  const outPath = valor('--out');
  const mdPath = valor('--md');
  const onlyId = valor('--only');

  const result = await runProbe({ providerFn, ...(onlyId ? { scenarioIds: [onlyId] } : {}) });

  if (outPath || mdPath) {
    const fs = await import('node:fs/promises');
    if (outPath) await fs.writeFile(outPath, JSON.stringify(toJSON(result), null, 2), 'utf8');
    if (mdPath) await fs.writeFile(mdPath, toMarkdown(result), 'utf8');
  }

  console.log(`# probe veredito: ${result.verdict}`);
  console.log(`# motivo: ${result.reason}`);
  console.log(
    `# totais: ${result.totals.runs} runs / ${result.totals.matches} match / ${result.totals.toolCalls} tool_call / ${result.totals.malformed} malformed`
  );
}
