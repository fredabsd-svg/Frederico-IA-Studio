// Testes do provedor REAL da sonda (`--live`).
//
// O defeito que estes testes travam era invisível justamente porque ninguém
// exercitava o caminho live: a rota e o CLI importavam `src/provider.js` e
// chamavam `generateOpenAICompatible`, e nenhum dos dois existe. A rota
// respondia 503 sempre; o CLI caía em dry-run e IMPRIMIA veredito — e dry-run
// devolve `no_tool` em todos os cenários, então a sonda dizia "este modelo não
// faz tool calling" sem ter chamado modelo nenhum.
import test from 'node:test';
import assert from 'node:assert/strict';

import { providerDeCliente, providerDoAmbiente, achatarResposta, SondaSemProvedor } from './provider.js';

// Cliente falso com a forma do SDK da OpenAI, guardando o pedido recebido.
function clienteFalso(resposta) {
  const pedidos = [];
  return {
    pedidos,
    chat: { completions: { create: async (params) => { pedidos.push(params); return resposta; } } }
  };
}

const RESPOSTA_COM_TOOL = {
  choices: [{ message: { content: null, tool_calls: [{ id: '1', function: { name: 'calculator', arguments: '{"a":12,"b":7}' } }] } }],
  usage: { total_tokens: 42 }
};

test('achatarResposta() entrega o formato que o classificador lê', () => {
  const plano = achatarResposta(RESPOSTA_COM_TOOL);
  assert.equal(plano.content, '');            // content nulo vira string
  assert.equal(plano.tool_calls.length, 1);
  assert.equal(plano.usage.total_tokens, 42);
  // Resposta vazia ou malformada não pode explodir: o runner precisa
  // classificá-la como `no_tool`/`malformed`, não morrer no meio da bateria.
  assert.deepEqual(achatarResposta(undefined), { content: '', tool_calls: [], usage: null });
  assert.deepEqual(achatarResposta({ choices: [] }).tool_calls, []);
});

test('o provedor da sonda chama o modelo com as ferramentas do cenário', async () => {
  const client = clienteFalso(RESPOSTA_COM_TOOL);
  const providerFn = providerDeCliente({ client, model: 'modelo-do-usuario' });
  const tools = [{ type: 'function', function: { name: 'calculator' } }];

  const plano = await providerFn([{ role: 'user', content: 'Quanto é 12 + 7?' }], { tools, maxTokens: 300 });

  assert.equal(client.pedidos.length, 1);
  assert.equal(client.pedidos[0].model, 'modelo-do-usuario');
  assert.deepEqual(client.pedidos[0].tools, tools);
  assert.equal(client.pedidos[0].max_tokens, 300);
  assert.equal(plano.tool_calls[0].function.name, 'calculator');
});

test('sem ferramentas no cenário, `tools` NÃO vai no pedido', async () => {
  // O modo `without_tools` da sonda existe para medir o que o modelo faz quando
  // não tem ferramenta. Mandar `tools: []` mudaria o que se está medindo.
  const client = clienteFalso({ choices: [{ message: { content: '19' } }] });
  await providerDeCliente({ client, model: 'm' })([{ role: 'user', content: 'oi' }], {});
  assert.ok(!('tools' in client.pedidos[0]), 'tools não deveria ser enviado');
});

test('o placeholder do runner não vira nome de modelo no pedido', async () => {
  // `probeRunner` põe 'probe-model' em options.model quando PROBE_MODEL não foi
  // definido. Enviá-lo daria "model not found" em todos os runs, e o veredito
  // sairia como se o modelo tivesse falhado.
  const client = clienteFalso({ choices: [{ message: { content: 'ok' } }] });
  const providerFn = providerDeCliente({ client, model: 'modelo-real' });
  await providerFn([], { model: 'probe-model' });
  assert.equal(client.pedidos[0].model, 'modelo-real');
  // Mas um PROBE_MODEL escolhido de propósito continua vencendo.
  await providerFn([], { model: 'modelo-escolhido' });
  assert.equal(client.pedidos[1].model, 'modelo-escolhido');
});

test('providerDoAmbiente() PARA quando falta chave ou modelo, em vez de cair em seco', () => {
  assert.throws(() => providerDoAmbiente({}), SondaSemProvedor);
  assert.throws(() => providerDoAmbiente({}), /sem chave de provedor/);
  assert.throws(() => providerDoAmbiente({ SONDA_API_KEY: 'k' }), /sem modelo/);
});

test('providerDoAmbiente() aceita os nomes alternativos documentados', () => {
  const doAmbiente = providerDoAmbiente({
    FREE_TIER_API_KEY: 'k', FREE_TIER_BASE_URL: 'https://exemplo.invalido/v1', DEFAULT_LLM: 'm'
  });
  assert.equal(typeof doAmbiente, 'function');
});

test('providerDeCliente() recusa cliente ou modelo ausente', () => {
  assert.throws(() => providerDeCliente({ model: 'm' }), SondaSemProvedor);
  assert.throws(() => providerDeCliente({ client: clienteFalso({}) }), /modelo do provedor ausente/);
});

test('a sonda inteira roda contra o provedor injetado e enxerga o tool call', async () => {
  const { runProbe } = await import('./probeRunner.js');
  const client = clienteFalso(RESPOSTA_COM_TOOL);
  const agregado = await runProbe({
    providerFn: providerDeCliente({ client, model: 'm' }),
    scenarioIds: ['math.simple_addition'],
    turns: 1
  });
  // with_tools + without_tools = 2 runs; ambos veem o tool call do cliente falso.
  assert.equal(agregado.totals.runs, 2);
  assert.equal(agregado.totals.toolCalls, 2);
  assert.equal(agregado.totals.malformed, 0);
  assert.equal(agregado.dryRun, false);
});

test('o agregado do dry-run se DECLARA seco, para o veredito não ser lido como do modelo', async () => {
  const { runProbe } = await import('./probeRunner.js');
  const seco = await runProbe({ scenarioIds: ['math.simple_addition'], turns: 1 });
  assert.equal(seco.dryRun, true);
  // Sem esta marca, o motivo ("modelo não emite tool calls mesmo quando
  // instruído") é uma frase sobre um modelo que nunca foi chamado.
  assert.match(seco.reason, /execução SECA/);
});
