// Conversa e streaming — o caminho que todo usuário percorre.
import { test, expect, criarConta, abrirLogado, enviar, ultimaRespostaDoAssistente, ui } from '../fixtures/app.js';

test('conta nova: manda mensagem e recebe a resposta em streaming', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'ALFA UM DOIS TRES');

  // A mensagem do usuário aparece na hora (otimista), antes do provedor responder.
  await expect(page.locator(ui.mensagensUsuario).last()).toContainText('ALFA UM DOIS TRES');

  // E a resposta chega — o provedor falso ecoa o que foi enviado.
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('ALFA UM DOIS TRES', { timeout: 60_000 });

  // Recarregar prova que a conversa foi PERSISTIDA, não só pintada na tela.
  // Ao recarregar, o app abre em "Nova conversa" — a de antes fica na barra
  // lateral, já com o título tirado da primeira mensagem.
  await page.reload();
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });

  const naBarra = page.locator(ui.itemConversa).filter({ hasText: 'ALFA UM DOIS TRES' });
  await expect(naBarra).toHaveCount(1, { timeout: 30_000 });
  await naBarra.click();

  await expect(page.locator(ui.mensagensUsuario).last()).toContainText('ALFA UM DOIS TRES', { timeout: 30_000 });
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('ALFA UM DOIS TRES', { timeout: 30_000 });
});

test('o texto aparece aos poucos, não de uma vez só', async ({ page, request }) => {
  // Se um dia o SSE for trocado por "espera terminar e mostra tudo", este teste
  // falha — que é o ponto. O modelo `eco-lento` pausa entre tokens.
  const conta = await criarConta(request, { modelo: 'eco-lento' });
  await abrirLogado(page, request, conta);

  const palavras = ['UM', 'DOIS', 'TRES', 'QUATRO', 'CINCO', 'SEIS', 'SETE', 'OITO', 'NOVE', 'DEZ', 'ONZE', 'DOZE'];
  await enviar(page, palavras.join(' '));

  const balao = page.locator(ui.mensagensAssistente).last();

  // Amostra o balão enquanto a resposta chega. Uma leitura só não serve: se ela
  // cair depois do fim do stream, o teste passaria a medir nada. Aqui coletamos
  // ao longo do caminho e cobramos que o texto tenha CRESCIDO — é isso que
  // distingue streaming de "espera terminar e mostra tudo de uma vez".
  const tamanhos = new Set();
  const limite = Date.now() + 60_000;
  let completo = '';
  while (Date.now() < limite) {
    const texto = (await balao.innerText().catch(() => '')).trim();
    if (texto) {
      tamanhos.add(texto.length);
      completo = texto;
      if (texto.includes('DOZE')) break;
    }
    await page.waitForTimeout(80);
  }

  expect(completo, 'a resposta completa deveria conter a última palavra').toContain('DOZE');
  expect(
    tamanhos.size,
    `o balão deveria ter crescido aos poucos; tamanhos observados: ${[...tamanhos].join(', ')}`
  ).toBeGreaterThan(1);
});

test('erro de chave inválida diz QUAL provedor recusou', async ({ page, request }) => {
  // Regressão do PR #140: com mais de um provedor cadastrado, o app dizia
  // "confira sua chave" sem nomear quem tinha recusado — e apontava o provedor
  // errado. A mensagem tem de nomear o provedor e o modelo.
  const conta = await criarConta(request, { modelo: 'chave-ruim' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'qualquer coisa');

  await expect(page.getByText(/Chave da API/i).first()).toBeVisible({ timeout: 60_000 });
  const aviso = await page.getByText(/Chave da API/i).first().innerText();
  expect(aviso, 'a mensagem precisa nomear o provedor').toContain('Provedor E2E');
  expect(aviso, 'a mensagem precisa nomear o modelo').toContain('chave-ruim');
});
