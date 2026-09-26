// Selo "quem de fato respondeu" na mensagem — navegador real, backend real.
//
// Antes, a troca de modelo (modo gratuito ou modelo de reserva no meio da
// execução) só aparecia como uma nota em itálico no fim do texto, e a troca de
// provedor nem isso. Agora o backend grava a troca no execution_meta e a
// mensagem mostra um selo no cabeçalho.
//
// Provocar a troca de verdade aqui exigiria a cadeia de reserva do servidor
// (MODEL_FALLBACKS) apontando para um provedor que só nasce durante o teste.
// A troca real é coberta pelo teste de integração do backend
// (loop.modelFailover.test.js); este cobre a TELA: a resposta real do banco é
// interceptada só para acrescentar o registro da troca ao reabrir a conversa.
import { test, expect, criarConta, abrirLogado, enviar, ui } from '../fixtures/app.js';

test('mensagem respondida por modelo de reserva mostra o selo; a normal não', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'SELO DE MODELO');
  const balao = page.locator(ui.mensagensAssistente).last();
  await expect(balao).toContainText('SELO DE MODELO', { timeout: 60_000 });
  await expect(page.locator('.working')).toHaveCount(0, { timeout: 30_000 });
  // Resposta normal: nenhum selo.
  await expect(balao.locator('.msgNotice')).toHaveCount(0);

  // Ao reabrir, a última resposta volta do banco com a troca registrada.
  await page.route(/\/api\/conversations\/[^/?]+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resposta = await route.fetch();
    const corpo = await resposta.json();
    const ultima = [...(corpo.messages || [])].reverse().find(m => m.role === 'assistant');
    if (ultima) {
      ultima.execution = {
        ...(ultima.execution || {}),
        modelFailover: { from: 'prov::modelo-que-caiu', to: 'prov::modelo-reserva' }
      };
    }
    await route.fulfill({ response: resposta, json: corpo });
  });
  await page.reload();
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });
  await page.locator(ui.itemConversa).filter({ hasText: 'SELO' }).first().click();

  const selo = page.locator(ui.mensagensAssistente).last().locator('.msgNotice');
  await expect(selo).toBeVisible({ timeout: 30_000 });
  await expect(selo).toContainText('Modelo de reserva · modelo-reserva');
  await expect(selo).toHaveAttribute('title', /modelo-que-caiu ficou indisponível/);
  // Nunca a referência interna `<provedor>::<modelo>` inteira.
  await expect(selo).not.toContainText('prov::');
});
