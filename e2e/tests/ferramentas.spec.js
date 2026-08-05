// Provedor falso exercitado além do eco: tool_calls no streaming e provedor
// travado (watchdog). É o que falta em F-13 — antes, o provedor só sabia
// devolver texto ou 401; um caminho crítico da camada de modelo (tool calling
// nativo) ficava descoberto pelos testes ponta a ponta.
//
// Por que existe um teste de stall AQUI se streamGuard já tem teste unitário:
// a unidade cobre o watchdog isolado; este teste cobre o laço COMPLETO do
// agente ao redor dele — provedor trava, watchdog detecta, recuperação
// acionada, fallback esgotado, aviso entregue ao usuário. O encadeamento só
// se prova de ponta a ponta, com o backend real recebendo o stream morto.
import { test, expect, criarConta, abrirLogado, enviar, ultimaRespostaDoAssistente, ui } from '../fixtures/app.js';

const SENHAO_TOOL = 'Ferramenta executada'; // rótulo da aba "Ambiente de Trabalho" quando o `bash` finaliza

test('modelo com tool_calls: a ferramenta aparece na conversa e o resultado volta ao usuário', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'ferramentas' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'roda uma ferramenta de teste');

  // O agente recebe a tool_call do provedor, executa `bash echo ok-e2e-tool`
  // (no E2E o sandbox pode não estar disponível — a falha do comando vira
  // tool_result mesmo assim) e reenvia ao provedor. A esta altura a UI já
  // mostrou a ferramenta rodando pelo menos uma vez.
  await expect(page.getByText(/Comando no terminal/).first()).toBeVisible({ timeout: 60_000 });

  // E a conversa termina com uma resposta do assistente — seja o eco do
  // provedor (`ok-e2e-tool recebido`) ou o aviso de falha do ambiente,
  // contanto que o laço não trave.
  await expect(page.locator(ui.mensagensAssistente).last()).toBeVisible({ timeout: 90_000 });
  const resposta = await ultimaRespostaDoAssistente(page);
  expect(resposta.length, 'o assistente precisa ter entregado alguma resposta').toBeGreaterThan(0);
});

test('provedor travado: o watchdog encerra o stream e o usuário recebe o aviso de indisponibilidade', async ({ page, request }) => {
  // O `travado` abre o stream e nunca envia nada além do delta inicial.
  // STREAM_STALL_TIMEOUT_MS=2000 (em playwright.config.js) faz o watchdog
  // disparar em ~2s; MODEL_STREAM_RECOVERY_LIMIT=1 fecha o ciclo em uma única
  // retentativa. No fim, o agente cai no PROVIDER_TIMEOUT_NOTICE — o aviso
  // em português que o usuário vê quando o provedor ficou indisponível.
  const conta = await criarConta(request, { modelo: 'travado' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'qualquer coisa');

  // O texto do aviso é gerado pelo backend (provider.js → PROVIDER_TIMEOUT_NOTICE).
  // Procuramos por um trecho estável em vez do texto inteiro, porque o ciclo
  // stall→retry→stall pode variar entre runs.
  await expect(
    page.getByText(/provedor do modelo ficou indispon/i).first()
  ).toBeVisible({ timeout: 60_000 });
});
