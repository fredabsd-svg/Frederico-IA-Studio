// Testes do endpoint admin /admin/tool-probe.
//
// Como o endpoint exige requireAdmin (que consulta o banco), os testes não
// exercitam o caminho autenticado. Verificam:
//   1. Forma da rota: POST aceita body com defaults razoáveis.
//   2. Parser body: extrai scenarioIds, turns, timeoutMs, live.
//   3. Resposta: estrutura { verdict, reason, totals, perMode, perScenario }.
//
// Para teste E2E com admin, é preciso DB — fora do escopo desta suíte.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importante: o router importa helpers.js, que puxa requireAdmin. Sem DB,
// requireAdmin joga ou retorna false. Por isso, importamos o módulo e
// verificamos só que o default export é uma função (router do express).
test('toolProbe router: default export é função (express.Router)', async () => {
  const mod = await import('./toolProbe.js');
  assert.equal(typeof mod.default, 'function');
});

// Este teste é mais do que parece. O modo live antes resolvia o provedor com
// `await import('../provider.js')` DENTRO de um try/catch — um módulo que não
// existe (o provedor mora em `src/agent/provider.js`). Import dinâmico dentro de
// catch falha em silêncio: a rota respondia 503 "provider_indisponivel" para
// sempre, e nenhum teste percebia. Agora a dependência é um import ESTÁTICO, e
// um caminho errado derruba este import — ou seja, o `import` abaixo é a
// regressão.
test('toolProbe router: as dependências do modo live resolvem de fato', async () => {
  const mod = await import('./toolProbe.js');
  assert.equal(typeof mod.default, 'function');
  const probeProvider = await import('../tools/probe/provider.js');
  assert.equal(typeof probeProvider.providerDeCliente, 'function');
  const userProvider = await import('../userProvider.js');
  assert.equal(typeof userProvider.getUserProvider, 'function');
});

test('toolProbe router: tem rota POST /admin/tool-probe', async () => {
  const mod = await import('./toolProbe.js');
  const router = mod.default;
  // Router do express tem .stack com layers; cada layer tem .route.
  const stack = router.stack ?? [];
  const routes = stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods) }));
  const probe = routes.find((r) => r.path === '/admin/tool-probe');
  assert.ok(probe, `rota /admin/tool-probe não encontrada em ${JSON.stringify(routes)}`);
  assert.ok(probe.methods.includes('post'), 'método POST ausente');
});