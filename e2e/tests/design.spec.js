// Modo Design ponta a ponta: navegador real, backend real, PostgreSQL real e o
// provedor falso devolvendo o artefato (modelos `design-web` e `design-slides`
// em fixtures/provedorFalso.mjs).
//
// O que só se prova aqui: que o HTML gerado é REALMENTE renderizado dentro do
// iframe isolado. As demais camadas já têm teste — o núcleo puro em
// backend/src/design/core.test.js e as rotas em routes/design.http.test.js —,
// mas nenhuma delas abre um navegador, e o preview é a promessa central do modo.
import assert from 'node:assert/strict';
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

// ---- v2: edição inline e controles de ajuste --------------------------------

test('clicar num elemento da prévia leva o alvo para o compositor', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'uma landing institucional');
  const frame = page.frameLocator('iframe[title="Prévia do design"]');
  await expect(frame.locator('#titulo-e2e')).toBeVisible({ timeout: 60_000 });

  // Só o navegador prova este caminho: o iframe está em ORIGEM OPACA, então o
  // clique só chega à interface pela ponte injetada + postMessage. Nenhum teste
  // de unidade cobre a travessia.
  await page.getByRole('button', { name: /Editar elemento/ }).click();
  await frame.locator('#titulo-e2e').click();

  // A etiqueta do alvo aparece acima do compositor e o placeholder muda —
  // é o que responde "o que eu vou mudar?" na hora de escrever o pedido.
  await expect(page.locator('.dsTargetChip')).toContainText('<h1>');
  await expect(page.locator('.dsTargetChip')).toContainText('Contabilidade sem sustos');
  await expect(page.getByPlaceholder('O que muda neste elemento?')).toBeFocused();

  // E o pedido sobe com o alvo: o histórico registra em que elemento foi.
  await page.getByPlaceholder('O que muda neste elemento?').fill('deixe o título maior');
  await page.getByPlaceholder('O que muda neste elemento?').press('Enter');
  await expect(page.locator('.dsBubble.user').last()).toContainText('<h1>', { timeout: 60_000 });
});

test('a seleção pode ser cancelada sem virar pedido', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'uma landing');
  const frame = page.frameLocator('iframe[title="Prévia do design"]');
  await expect(frame.locator('#titulo-e2e')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: /Editar elemento/ }).click();
  await frame.locator('#texto-e2e').click();
  await expect(page.locator('.dsTargetChip')).toBeVisible();

  await page.locator('.dsTargetChip button').click();
  await expect(page.locator('.dsTargetChip')).toHaveCount(0);
  await expect(page.getByPlaceholder('O que você quer mudar?')).toBeVisible();
});

test('o slider muda a prévia na hora, sem gerar versão nova', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'uma landing com marca');
  const frame = page.frameLocator('iframe[title="Prévia do design"]');
  const titulo = frame.locator('#titulo-e2e');
  await expect(titulo).toBeVisible({ timeout: 60_000 });

  const corInicial = await titulo.evaluate(el => getComputedStyle(el).color);

  await page.getByRole('tab', { name: /Ajustes/ }).click();
  // Os controles são derivados do artefato: o HTML do provedor falso declara
  // quatro variáveis, então são quatro controles.
  await expect(page.locator('.dsAdjustItem')).toHaveCount(4);

  await page.locator('.dsAdjustHex').first().fill('#0a7d55');
  await page.locator('.dsAdjustHex').first().blur();

  // A cor muda DENTRO do iframe — o CSS foi aplicado por postMessage, sem
  // recarregar a página e sem passar pelo modelo.
  await expect.poll(async () => titulo.evaluate(el => getComputedStyle(el).color), { timeout: 15_000 })
    .toBe('rgb(10, 125, 85)');
  assert(corInicial !== 'rgb(10, 125, 85)');

  // E não nasceu versão nenhuma: ajustar não é gerar.
  await page.getByRole('tab', { name: /Versões/ }).click();
  await expect(page.locator('.dsVersion')).toHaveCount(1);
});

test('o ajuste é gravado e sobrevive a reabrir o projeto', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'uma landing persistente');
  const frame = page.frameLocator('iframe[title="Prévia do design"]');
  await expect(frame.locator('#titulo-e2e')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('tab', { name: /Ajustes/ }).click();
  await page.locator('.dsAdjustHex').first().fill('#0a7d55');
  await page.locator('.dsAdjustHex').first().blur();
  await expect(page.locator('.dsAdjustItem').first()).toHaveClass(/on/);

  // Sai e volta: o valor gravado tem de vir do servidor, já aplicado na prévia.
  await page.getByRole('button', { name: 'Projetos' }).click();
  await page.getByText('uma landing persistente').click();
  const frame2 = page.frameLocator('iframe[title="Prévia do design"]');
  await expect.poll(async () => frame2.locator('#titulo-e2e').evaluate(el => getComputedStyle(el).color), { timeout: 30_000 })
    .toBe('rgb(10, 125, 85)');
});

// ---- Modelo de IA por projeto ------------------------------------------------

test('o seletor de modelo fica DENTRO do editor e o modelo é fixado no projeto', async ({ page, request }) => {
  await abrirModoDesign(page, request, 'design-web');
  await gerarPrimeiroProjeto(page, 'Site ou protótipo', 'uma landing com modelo fixado');
  const frame = page.frameLocator('iframe[title="Prévia do design"]');
  await expect(frame.locator('#titulo-e2e')).toBeVisible({ timeout: 60_000 });

  // A lacuna que este teste guarda: o Modo Design ocupa a tela inteira, então o
  // seletor do chat fica atrás dele. Se o seletor sair da barra do editor,
  // trocar de modelo volta a exigir fechar e reabrir a tela.
  const seletor = page.locator('.dsModel .mpBtn');
  await expect(seletor).toBeVisible();
  await expect(seletor).toContainText('design-web');

  // Abrir e fechar o painel funciona por cima do overlay (z-index correto) — e
  // o Esc que fecha a LISTA não pode fechar o Modo Design junto. Foi este teste
  // que pegou isso: o seletor entrou no editor e passou a disputar a mesma
  // tecla com o atalho de sair da tela.
  await seletor.click();
  await expect(page.locator('.dsModel .mpPanel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dsModel .mpPanel')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Modo Design' })).toBeVisible();

  // O modelo ficou GRAVADO no projeto — não é mais o "modelo atual do app".
  // (A troca em si tem teste de rota; aqui a conta enxerga um modelo só, que é
  // o que torna o resto da suíte determinístico.)
  const lista = await request.get('/api/design/projects');
  const projeto = (await lista.json())[0];
  expect(projeto.modelRef).toContain('design-web');

  // E sobrevive a fechar e reabrir o projeto.
  await page.getByRole('button', { name: 'Projetos' }).click();
  await page.getByText('uma landing com modelo fixado').click();
  await expect(page.locator('.dsModel .mpBtn')).toContainText('design-web');
});
