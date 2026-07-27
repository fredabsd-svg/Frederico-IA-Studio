// Primeiro acesso: landing → cadastro → app, e o portão de consentimento.
// Os outros testes pulam esse caminho pela API para irem direto ao que querem
// provar; aqui ele é o objeto do teste.
//
// São DOIS caminhos diferentes, e a diferença importa:
//   * quem se cadastra pelo formulário já marca o aceite ali, e entra direto;
//   * quem chega por outro caminho (login social, conta criada antes do
//     recurso, termos atualizados) cai no portão do PrivacyPanel.
// O aceite é exigência legal (LGPD): se o portão sumir por acidente, uma conta
// passa a usar o app sem ter aceitado nada e ninguém percebe.
import { test, expect, ui } from '../fixtures/app.js';

const SENHA = 'senha-de-teste-12345';

function emailNovo(sufixo) {
  return `e2e-ui-${process.pid}-${sufixo}-${Math.floor(performance.now())}@teste.local`;
}

test('cadastro pela interface exige o aceite no formulário e abre o app', async ({ page }) => {
  const email = emailNovo('cadastro');
  await page.goto('/');

  // Landing → tela de cadastro.
  await page.getByRole('button', { name: 'Criar conta grátis' }).first().click();

  await page.getByPlaceholder('Seu nome').fill('Teste E2E');
  await page.getByPlaceholder('E-mail').fill(email);
  await page.getByPlaceholder(/Crie uma senha/).fill(SENHA);

  const criar = page.getByRole('button', { name: 'Criar conta' });
  await expect(criar, 'criar conta sem marcar o aceite não pode ser possível').toBeDisabled();
  await page.locator('.loginConsent input[type="checkbox"]').check();
  await expect(criar).toBeEnabled();
  await criar.click();

  // Como o aceite foi dado no próprio formulário, o app abre direto — sem
  // pedir a mesma coisa de novo.
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: /Termos de Uso e Política de Privacidade/ })).toHaveCount(0);
});

test('conta sem aceite registrado fica presa no portão de consentimento', async ({ page, request }) => {
  // Cria a conta pela API e NÃO aceita nada — é a situação de quem entrou por
  // login social ou de quem já tinha conta quando os termos mudaram.
  const email = emailNovo('portao');
  const cadastro = await request.post('/api/auth/sign-up/email', {
    data: { email, password: SENHA, name: 'Teste E2E' }
  });
  expect(cadastro.ok(), `falha ao criar a conta: ${cadastro.status()}`).toBeTruthy();

  const estado = await request.storageState();
  await page.context().addCookies(estado.cookies);
  await page.goto('/');

  const portao = page.getByRole('dialog', { name: /Termos de Uso e Política de Privacidade/ });
  await expect(portao).toBeVisible({ timeout: 30_000 });

  // O app fica ATRÁS do portão: o compositor chega a ser renderizado, mas o
  // overlay é modal e intercepta o ponteiro. Então o que se cobra aqui não é
  // "sumiu" e sim "não dá para usar" — que é a garantia que interessa.
  let bloqueado = false;
  try { await page.getByPlaceholder(ui.campoMensagem).click({ timeout: 3000 }); }
  catch { bloqueado = true; }
  expect(bloqueado, 'sem aceitar os termos, não deveria ser possível usar o compositor').toBe(true);

  const aceitar = portao.getByRole('button', { name: 'Aceitar e continuar' });
  await expect(aceitar, 'aceitar sem marcar a caixa não pode ser possível').toBeDisabled();
  await portao.locator('input[type="checkbox"]').check();
  await aceitar.click();

  await expect(portao).toBeHidden({ timeout: 30_000 });
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });
});

test('sair e entrar de novo com a mesma conta', async ({ page, request }) => {
  const email = emailNovo('voltar');

  const cadastro = await request.post('/api/auth/sign-up/email', {
    data: { email, password: SENHA, name: 'Teste E2E' }
  });
  expect(cadastro.ok(), `falha ao criar a conta: ${cadastro.status()}`).toBeTruthy();
  expect((await request.post('/api/consent')).ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: 'Entrar' }).first().click();
  await page.getByPlaceholder('E-mail').fill(email);
  await page.getByPlaceholder('Senha').fill(SENHA);
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();

  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });

  // E sem sessão o app volta para a landing, não para o chat.
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Criar conta grátis' }).first()).toBeVisible({ timeout: 30_000 });
});
