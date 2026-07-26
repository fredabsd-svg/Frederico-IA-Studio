// Multiconversa e reconexão do SSE.
//
// É o item 1 da lista "para chegar ao verde" (docs/AUDITORIA_2026-07.md §6):
// "Teste integrado de SSE: duas conversas, troca rápida, reconexão". Nada disso
// dá para provar com teste de módulo — depende de EventSource de verdade, do
// estado do React sobrevivendo à troca de conversa e do backend continuar a
// execução mesmo sem ninguém ouvindo.
import { test, expect, criarConta, abrirLogado, enviar, ui } from '../fixtures/app.js';

const ALFA = ['ALFA', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'AFIM'];
const BETA = ['BETA', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'BFIM'];

// Espera o balão do assistente começar a receber texto (sem esperar o fim).
async function esperarComecar(page, trecho) {
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText(trecho, { timeout: 60_000 });
}

function conversaNaBarra(page, titulo) {
  return page.locator(ui.itemConversa).filter({ hasText: titulo });
}

test('trocar de conversa no meio do streaming não mistura as respostas', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco-lento' });
  await abrirLogado(page, request, conta);

  // Conversa 1 começa a responder...
  await enviar(page, ALFA.join(' '));
  await esperarComecar(page, 'ALFA');

  // ...e no meio dela abrimos outra e mandamos algo diferente.
  await page.locator(ui.botaoNovaConversa).click();
  await expect(page.locator(ui.mensagensUsuario)).toHaveCount(0);
  await enviar(page, BETA.join(' '));
  await esperarComecar(page, 'BETA');

  // Volta para a primeira: o app promete reconectar ao andamento (App.jsx,
  // blockConversationChange). A resposta tem de chegar inteira.
  await conversaNaBarra(page, 'ALFA').click();
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('AFIM', { timeout: 60_000 });

  const textoAlfa = await page.locator(ui.mensagensAssistente).last().innerText();
  expect(textoAlfa, 'a resposta da conversa ALFA não pode conter nada da BETA').not.toMatch(/\bB\d\b|BETA|BFIM/);

  // E a segunda continua íntegra também.
  await conversaNaBarra(page, 'BETA').click();
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('BFIM', { timeout: 60_000 });

  const textoBeta = await page.locator(ui.mensagensAssistente).last().innerText();
  expect(textoBeta, 'a resposta da conversa BETA não pode conter nada da ALFA').not.toMatch(/\bA\d\b|ALFA|AFIM/);
});

test('recarregar a página no meio da resposta não perde a resposta', async ({ page, request }) => {
  // Reconexão de verdade: a execução segue no servidor mesmo sem ninguém
  // ouvindo, e ao reabrir a conversa o front pega o que passou (o /stream
  // reproduz o buffer) e continua ao vivo até o fim.
  const conta = await criarConta(request, { modelo: 'eco-lento' });
  await abrirLogado(page, request, conta);

  await enviar(page, ALFA.join(' '));
  await esperarComecar(page, 'ALFA');

  // Derruba a conexão no meio do caminho.
  await page.reload();
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });

  await conversaNaBarra(page, 'ALFA').click();

  // Mesmo tendo perdido parte dos eventos, o texto completo aparece.
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('AFIM', { timeout: 60_000 });
  const texto = await page.locator(ui.mensagensAssistente).last().innerText();
  for (const palavra of ALFA) {
    expect(texto, `faltou "${palavra}" depois da reconexão`).toContain(palavra);
  }
});

test('a barra lateral mostra que a outra conversa ainda está processando', async ({ page, request }) => {
  // O indicador girando é como a pessoa sabe, olhando para OUTRA conversa, que
  // a primeira continua trabalhando. Por isso o teste sai da conversa: enquanto
  // ela é a única e está aberta, ainda nem entrou na lista da barra lateral.
  const conta = await criarConta(request, { modelo: 'eco-lento' });
  await abrirLogado(page, request, conta);

  // Mensagem longa de propósito: precisa continuar respondendo depois que
  // sairmos dela.
  const longa = ['ALFA', ...Array.from({ length: 30 }, (_, i) => `A${i}`), 'AFIM'];
  await enviar(page, longa.join(' '));
  await esperarComecar(page, 'ALFA');

  // Sai para uma conversa nova — a primeira vai para a lista, ainda ocupada.
  await page.locator(ui.botaoNovaConversa).click();

  // Sem casar por título: a conversa entra na lista ainda chamada "Nova
  // conversa" e só depois recebe o nome tirado da primeira mensagem. Como só há
  // uma execução em andamento, basta cobrar que a lista mostre exatamente um
  // indicador — e que ele apague quando a resposta acabar.
  await expect(page.locator(ui.conversaProcessando)).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(ui.conversaProcessando)).toHaveCount(0, { timeout: 120_000 });
});
