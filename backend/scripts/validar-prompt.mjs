#!/usr/bin/env node
// Validação de COMPORTAMENTO do prompt v4.2 (o gate que teste unitário não fecha).
//
// Uso:
//   node scripts/validar-prompt.mjs                        # seco: não chama provedor
//   node scripts/validar-prompt.mjs --live                 # chama o provedor de verdade
//   node scripts/validar-prompt.mjs --live --md rel.md     # grava o relatório
//   node scripts/validar-prompt.mjs --live --only data.hoje
//
// Configuração do modo --live (nunca commite chave; use o .env ou o ambiente):
//   VALIDACAO_API_KEY   (ou FREE_TIER_API_KEY)
//   VALIDACAO_BASE_URL  (ou FREE_TIER_BASE_URL, DEEPSEEK_BASE_URL)
//   VALIDACAO_MODELO    (ou --modelo <id>)
//
// Rode a bateria em DOIS modelos — um forte e um gratuito. O prompt precisa
// funcionar nos dois, e é no modelo fraco que a instrução ambígua aparece.

import { rodarValidacao, relatorioMarkdown } from '../src/agent/promptValidation/runner.js';

const argv = process.argv.slice(2);
const valor = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const live = argv.includes('--live');
const caminhoMd = valor('--md');
const caminhoJson = valor('--json');
const so = valor('--only');
const modelo = valor('--modelo') || process.env.VALIDACAO_MODELO || null;

function providerDoAmbiente() {
  const apiKey = process.env.VALIDACAO_API_KEY || process.env.FREE_TIER_API_KEY;
  const baseURL = process.env.VALIDACAO_BASE_URL || process.env.FREE_TIER_BASE_URL || process.env.DEEPSEEK_BASE_URL;
  if (!apiKey) {
    console.error('# --live pedido, mas não há VALIDACAO_API_KEY nem FREE_TIER_API_KEY no ambiente.');
    console.error('# Defina a chave (e VALIDACAO_MODELO) e rode de novo. Nada foi chamado.');
    process.exit(2);
  }
  if (!modelo) {
    console.error('# --live pedido, mas nenhum modelo foi informado (VALIDACAO_MODELO ou --modelo).');
    process.exit(2);
  }
  return async ({ mensagens, ferramentas }) => {
    const { createAiClient } = await import('../src/aiClient.js');
    const client = createAiClient({ apiKey, baseURL });
    return client.chat.completions.create({
      model: modelo,
      messages: mensagens,
      temperature: 0,
      max_tokens: 1200,
      ...(ferramentas.length ? { tools: ferramentas } : {})
    });
  };
}

const agregado = await rodarValidacao({
  providerFn: live ? providerDoAmbiente() : null,
  modelo,
  ids: so ? [so] : null
});

if (caminhoMd || caminhoJson) {
  const fs = await import('node:fs/promises');
  if (caminhoMd) await fs.writeFile(caminhoMd, relatorioMarkdown(agregado), 'utf8');
  if (caminhoJson) await fs.writeFile(caminhoJson, JSON.stringify(agregado, null, 2), 'utf8');
}

console.log(`# veredito: ${agregado.veredito}`);
if (agregado.seco) {
  console.log('# execução SECA — nenhum provedor foi chamado. Use --live para valer.');
} else {
  const t = agregado.totais;
  console.log(`# totais: ${t.passou} passou / ${t.reprovou} reprovou / ${t.erro} erro (de ${t.casos})`);
  for (const r of agregado.resultados) {
    if (r.veredito === 'passou') continue;
    const motivos = r.erro ? r.erro : r.achados.filter((a) => !a.ok).map((a) => a.motivo).join('; ');
    console.log(`- ${r.veredito.toUpperCase()} ${r.id}: ${motivos}`);
  }
  if (!caminhoMd) console.log('# use --md <arquivo> para o relatório com as respostas inteiras (a leitura humana é parte do gate).');
}

// Reprovação de comportamento é falha; provedor indisponível não é.
process.exit(agregado.veredito === 'reprovou' ? 1 : 0);
