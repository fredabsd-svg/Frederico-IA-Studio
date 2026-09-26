// "Parar" no meio da resposta — navegador real, backend real.
//
// Medição que motivou este teste: o texto parava em ~400 ms depois do clique,
// mas a resposta cortada era gravada como "completed" e a tela não dizia que
// ela estava incompleta — nem ao vivo, nem depois de recarregar. A causa era o
// backend: quando o abort chegava enquanto o loop esperava o próximo pedaço do
// provedor, o stream terminava "limpo" e a parada não era registrada.
import { test, expect, criarConta, abrirLogado, enviar, ui } from '../fixtures/app.js';

const PALAVRAS = Array.from({ length: 40 }, (_, i) => `P${i}`);

test('Parar no meio: o texto para, a resposta é marcada como interrompida e continua assim após recarregar', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco-lento' });
  await abrirLogado(page, request, conta);

  await enviar(page, PALAVRAS.join(' '));
  const balao = page.locator(ui.mensagensAssistente).last();
  await expect(balao).toContainText('P3', { timeout: 60_000 });

  await page.getByRole('button', { name: /Parar/ }).first().click();

  // O indicador de processamento some e o texto para de crescer.
  await expect(page.locator('.working')).toHaveCount(0, { timeout: 10_000 });
  const depoisDoClique = await balao.innerText();
  await page.waitForTimeout(1_500);
  expect(await balao.innerText(), 'o texto não pode continuar chegando depois do Parar').toBe(depoisDoClique);
  expect(depoisDoClique, 'a resposta não pode ter ido até o fim').not.toContain('P39');

  // A tela diz que está incompleta — o estado vem do backend.
  await expect(balao.locator('.msgStopped')).toBeVisible();
  await expect(balao.locator('.msgStopped')).toContainText('interrompida');

  // Recarregar mostra a MESMA coisa: estado e texto gravados, não só pintados.
  await page.reload();
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });
  await page.locator(ui.itemConversa).filter({ hasText: 'P0' }).first().click();
  const reaberto = page.locator(ui.mensagensAssistente).last();
  await expect(reaberto.locator('.msgStopped')).toBeVisible({ timeout: 30_000 });
  expect(await reaberto.innerText()).not.toContain('P39');
});

test('resposta que termina normalmente não recebe o aviso de interrompida', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);
  await enviar(page, 'RESPOSTA COMPLETA');
  const balao = page.locator(ui.mensagensAssistente).last();
  await expect(balao).toContainText('RESPOSTA COMPLETA', { timeout: 60_000 });
  await expect(page.locator('.working')).toHaveCount(0, { timeout: 30_000 });
  await expect(balao.locator('.msgStopped')).toHaveCount(0);
});
