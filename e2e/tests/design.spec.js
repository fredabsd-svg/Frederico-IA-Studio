// Modo Design ponta a ponta: navegador real, backend real, PostgreSQL real e o
// provedor falso devolvendo o artefato (modelos `design-web` e `design-slides`
// em fixtures/provedorFalso.mjs).
//
// O que só se prova aqui: que o HTML gerado é REALMENTE renderizado dentro do
// iframe isolado. As demais camadas já têm teste — o núcleo puro em
// backend/src/design/core.test.js e as rotas em routes/design.http.test.js —,
// mas nenhuma delas abre um navegador, e o preview é a promessa central do modo.
import { test, expect, criarConta, abrirLogado } from '../fixtures/app.js';

async function abrirModoDesign(page, request, modelo) {
  const conta = await criarConta(request, { modelo });
  await abrirLogado(page, request, conta);
  await page.getByRole('button', { name: 'Modo Design' }).click();
  await expect(page.getByRole('dialog', { name: 'Modo Design' })).toBeVisible();
  return conta;
}

async function gerarPrimeiroProjeto(page, tipo, pedido) {
  await page.getByRole('button', { name: /Criar o primeiro|Novo projeto/ }).first().click();
  await page.getByRole('radio', { name: new RegExp(tipo, 'i') }).click();
  await page.getByPlaceholder(/Ex\.:/).fill(pedido);
  await page.getByRole('button', { name: /Gerar rascunho/ }).click();
}

test('cria um site pelo pedido em texto e renderiza a prévia no iframe', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'uma landing para escritório de contabilidade');

  // A geração leva um tempo real (chamada ao provedor + gravação da versão).
  const frame = page.frameLocator('iframe[title="Prévia do design"]');
  await expect(frame.locator('#titulo-e2e')).toHaveText('Contabilidade sem sustos', { timeout: 60_000 });

  // A resposta do provedor vem com conversa em volta e cerca de código; nada
  // disso pode ter entrado no artefato renderizado.
  await expect(frame.locator('body')).not.toContainText('Qualquer ajuste');
});

test('a prévia fica em origem opaca: sandbox sem allow-same-origin', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'uma página simples');

  const iframe = page.locator('iframe[title="Prévia do design"]');
  await expect(iframe).toBeVisible({ timeout: 60_000 });

  // Guarda da regressão que quebraria o isolamento inteiro: com
  // `allow-same-origin` junto de `allow-scripts`, o HTML gerado por IA passaria
  // a compartilhar a origem do app — cookie de sessão e DOM inclusos.
  const sandbox = await iframe.getAttribute('sandbox');
  expect(sandbox).toBe('allow-scripts');

  // E o documento servido carimba o mesmo sandbox no CSP, para valer também
  // quando alguém abre a URL da prévia direto no navegador.
  const src = await iframe.getAttribute('src');
  const resposta = await request.get(src.split('#')[0]);
  const csp = resposta.headers()['content-security-policy'] || '';
  expect(csp).toContain('sandbox allow-scripts');
  expect(csp).not.toContain('allow-same-origin');
});

test('refinar por conversa cria uma versão nova e dá para voltar atrás', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'uma landing institucional');

  const frame = page.frameLocator('iframe[title="Prévia do design"]');
  await expect(frame.locator('#titulo-e2e')).toBeVisible({ timeout: 60_000 });

  await page.getByPlaceholder('O que você quer mudar?').fill('deixe o título maior');
  await page.getByPlaceholder('O que você quer mudar?').press('Enter');

  // A fala do usuário aparece no chat do projeto e a segunda versão nasce.
  // São DUAS bolhas do usuário: o pedido que criou o projeto também entra no
  // histórico da conversa — é o que dá contexto ao refinamento seguinte.
  await expect(page.locator('.dsBubble.user')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator('.dsBubble.user').last()).toContainText('deixe o título maior');
  await page.getByRole('tab', { name: /Versões/ }).click();
  await expect(page.locator('.dsVersion')).toHaveCount(2, { timeout: 60_000 });

  // Voltar para a v1: o ponteiro muda e o histórico continua com as duas.
  await expect(page.locator('.dsVersion').first()).toContainText('atual');
  await page.locator('.dsVersion').last().getByRole('button', { name: /Voltar para esta/ }).click();
  await expect(page.locator('.dsVersion').last()).toContainText('Em exibição');
  await expect(page.locator('.dsVersion')).toHaveCount(2, 'reverter não apaga o que veio depois');
});

test('apresentação vira um deck renderizado, não JSON na tela', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-slides');
  await gerarPrimeiroProjeto(page, 'Apresentação', 'uma proposta de 2 slides');

  const frame = page.frameLocator('iframe[title="Prévia do design"]');
  await expect(frame.locator('.slide')).toHaveCount(2, { timeout: 60_000 });
  await expect(frame.locator('.slide').first()).toContainText('Proposta E2E');
  // O JSON é o formato de armazenamento; quem aparece é o deck.
  await expect(frame.locator('body')).not.toContainText('"layout"');
});

test('o projeto criado aparece na lista ao voltar', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'catálogo de serviços contábeis');
  await expect(page.frameLocator('iframe[title="Prévia do design"]').locator('#titulo-e2e')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Projetos' }).click();
  // Sem título informado, o pedido vira o nome do projeto.
  await expect(page.getByText('catálogo de serviços contábeis')).toBeVisible();
});
