// Layout: nada pode cobrir o botão de enviar.
//
// Este arquivo nasceu de um defeito real. O personagem do copiloto é
// `position: fixed` no canto inferior direito e pousava EM CIMA do botão de
// enviar: em 1280px a sobreposição era de 23px e, de 1100px para baixo, o botão
// ficava INTEIRAMENTE coberto — no celular, tocar em "enviar" acertava o
// mascote. Passou despercebido por anos porque nenhum teste abria o app num
// navegador; foi a suíte E2E que o encontrou, ao ter o clique recusado.
//
// A correção está em `frontend/src/hooks/useComposerHeight.js` (publica a altura
// real do compositor em `--composer-h`) e em `companion.css` (o personagem pousa
// acima dele). Estes testes são o guarda: se alguém voltar a pôr um valor fixo
// no `bottom`, eles falham.
//
// A SEGUNDA metade do arquivo cobre o mesmo defeito por outro caminho: o CSS só
// governa o personagem enquanto ele está no canto. ARRASTADO, ele passa a ter
// `left`/`top` absolutos e voltava a pousar sobre o botão de enviar e sobre o
// cabeçalho do terminal (medido por hit test: `elementFromPoint` no botão
// "Maximizar o terminal" devolvia o SVG do mascote, e o clique era recusado).
// O guarda agora é `protectedBottomInset` em `frontend/src/companionPosition.js`.
import { test, expect, criarConta, abrirLogado, enviar, ui } from '../fixtures/app.js';

// Da tela larga ao celular. As faixas do meio são as que quebravam.
const LARGURAS = [1920, 1440, 1280, 1100, 980, 820, 560, 390];

// Quantos pixels o personagem invade o botão de enviar (0 = não invade).
async function sobreposicaoComOEnviar(page) {
  return page.evaluate(() => {
    const caixa = (seletor) => {
      const elemento = document.querySelector(seletor);
      return elemento ? elemento.getBoundingClientRect() : null;
    };
    const botao = caixa('.composer .sendBtn');
    const personagem = caixa('.companionRoot');
    if (!botao || !personagem) return -1; // faltou elemento: o teste acusa
    const x = Math.min(botao.right, personagem.right) - Math.max(botao.left, personagem.left);
    const y = Math.min(botao.bottom, personagem.bottom) - Math.max(botao.top, personagem.top);
    return (x > 0 && y > 0) ? Math.round(Math.min(x, y)) : 0;
  });
}

test('o personagem do copiloto nunca cobre o botão de enviar', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);

  for (const largura of LARGURAS) {
    await page.setViewportSize({ width: largura, height: 800 });
    // Deixa o layout assentar (o ResizeObserver republica --composer-h).
    await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible();
    await page.waitForTimeout(250);

    const invasao = await sobreposicaoComOEnviar(page);
    expect(invasao, `a ${largura}px, o personagem invade o botão de enviar`).toBe(0);
  }
});

test('o compositor cresce sem empurrar o personagem para cima do botão', async ({ page, request }) => {
  // O compositor não tem altura fixa: a textarea cresce até 160px conforme o
  // texto. Um `bottom` fixo no CSS passaria no teste acima e falharia aqui.
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);
  await page.setViewportSize({ width: 1280, height: 800 });

  const campo = page.getByPlaceholder(ui.campoMensagem);
  await campo.click();
  await campo.fill(Array.from({ length: 12 }, (_, i) => `linha ${i + 1} do texto longo`).join('\n'));
  await page.waitForTimeout(400);

  expect(await sobreposicaoComOEnviar(page), 'com o compositor alto, o personagem invadiu o botão').toBe(0);
});

test('o botão de enviar recebe o clique no desktop e no celular', async ({ page, request }) => {
  // O teste mais direto: clicar no botão. Era exatamente isto que o Playwright
  // recusava antes — "o mascote intercepta o ponteiro" — e é o que a pessoa faz.
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);

  for (const [rotulo, largura] of [['desktop', 1280], ['celular', 390]]) {
    await page.setViewportSize({ width: largura, height: 800 });
    await page.waitForTimeout(250);

    const texto = `CLIQUE ${rotulo.toUpperCase()}`;
    const campo = page.getByPlaceholder(ui.campoMensagem);
    await campo.click();
    await campo.fill(texto);
    // Sem force: se algo estiver por cima, o clique é recusado — que é o ponto.
    await page.getByLabel(ui.botaoEnviar).click({ timeout: 10_000 });

    await expect(page.locator(ui.mensagensUsuario).last(), `a mensagem não foi enviada no ${rotulo}`).toContainText(texto);
    // Espera a resposta terminar antes do próximo envio (o app recusa mensagem
    // nova enquanto a conversa está processando).
    await expect(page.locator(ui.mensagensAssistente).last()).toContainText(texto, { timeout: 60_000 });
  }
});

test('o compositor e o personagem continuam visíveis dentro da janela', async ({ page, request }) => {
  // Guarda contra a correção exagerar: empurrar o personagem para fora da tela
  // resolveria a sobreposição e quebraria o recurso.
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);

  for (const largura of [1280, 390]) {
    await page.setViewportSize({ width: largura, height: 800 });
    await page.waitForTimeout(250);

    const dentro = await page.evaluate(() => {
      const r = document.querySelector('.companionRoot')?.getBoundingClientRect();
      if (!r) return null;
      return { visivel: r.width > 0 && r.height > 0, top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right) };
    });
    expect(dentro, `a ${largura}px o personagem sumiu do DOM`).not.toBeNull();
    expect(dentro.visivel, `a ${largura}px o personagem ficou sem tamanho`).toBe(true);
    expect(dentro.top, `a ${largura}px o personagem saiu pelo topo da janela`).toBeGreaterThanOrEqual(0);
    expect(dentro.bottom, `a ${largura}px o personagem saiu pela base da janela`).toBeLessThanOrEqual(800);
    expect(dentro.right, `a ${largura}px o personagem saiu pela lateral`).toBeLessThanOrEqual(largura);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// O PERSONAGEM ARRASTADO
// ═══════════════════════════════════════════════════════════════════════════

// Arrasta o personagem com ponteiro de verdade: é o `pointerdown` no avatar que
// o app escuta, e são os `pointermove` no documento que movem. Devolve a caixa
// final para o teste poder afirmar sobre ela.
async function arrastarONino(page, destino) {
  const avatar = page.locator('.cmpAvatarWrap');
  const antes = await avatar.boundingBox();
  await page.mouse.move(antes.x + antes.width / 2, antes.y + antes.height / 2);
  await page.mouse.down();
  await page.mouse.move(destino.x, destino.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  return page.locator('.companionRoot').boundingBox();
}

// Quem está DE FATO sob um ponto da tela. É a pergunta que o clique faz.
const quemEstaEm = (page, x, y) => page.evaluate(([px, py]) => {
  const alvo = document.elementFromPoint(px, py);
  if (!alvo) return null;
  return { dentroDoNino: !!alvo.closest('.companionRoot') };
}, [x, y]);

test('o personagem arrastado para o rodapé não cobre o botão de enviar', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible();
  await page.waitForTimeout(250);

  const enviarBtn = page.getByRole('button', { name: ui.botaoEnviar });
  const alvo = await enviarBtn.boundingBox();
  // Arrasta o Nino EXATAMENTE para cima do botão de enviar.
  await arrastarONino(page, { x: alvo.x + alvo.width / 2, y: alvo.y + alvo.height / 2 });

  const centro = { x: alvo.x + alvo.width / 2, y: alvo.y + alvo.height / 2 };
  const sob = await quemEstaEm(page, centro.x, centro.y);
  expect(sob, 'nada sob o botão de enviar: o teste mediu o vazio').not.toBeNull();
  expect(sob.dentroDoNino, 'o personagem arrastado pousou sobre o botão de enviar').toBe(false);

  // E o clique chega. Sem `force`: é o Playwright quem recusa se algo estiver por cima.
  const campo = page.getByPlaceholder(ui.campoMensagem);
  await campo.click();
  await campo.fill('ARRASTEI O NINO');
  await enviarBtn.click({ timeout: 10_000 });
  await expect(page.locator(ui.mensagensUsuario).last()).toContainText('ARRASTEI O NINO');
});

test('o personagem arrastado não cobre os botões do terminal', async ({ page, request }) => {
  // O caso que motivou a correção. Com o terminal aberto, a faixa de controles
  // sobe: o cabeçalho fica ~300px acima do compositor, e o Nino arrastado para o
  // rodapé pousava justo nele, engolindo recolher/expandir/maximizar.
  const conta = await criarConta(request, { modelo: 'ferramentas-lentas' });
  await abrirLogado(page, request, conta);
  await page.setViewportSize({ width: 1280, height: 800 });

  await enviar(page, 'Rode o comando de teste.');
  const terminal = page.locator('.execDock');
  await expect(terminal).toBeVisible({ timeout: 60_000 });
  await terminal.getByRole('button', { name: 'Expandir o terminal' }).first().click();
  await expect(terminal).toHaveClass(/expanded/);
  await page.waitForTimeout(250);

  const maximizar = terminal.getByRole('button', { name: 'Maximizar o terminal' });
  const alvo = await maximizar.boundingBox();
  const centro = { x: alvo.x + alvo.width / 2, y: alvo.y + alvo.height / 2 };
  await arrastarONino(page, centro);

  const sob = await quemEstaEm(page, centro.x, centro.y);
  expect(sob, 'nada sob o botão do terminal: o teste mediu o vazio').not.toBeNull();
  expect(sob.dentroDoNino, 'o personagem arrastado pousou sobre o cabeçalho do terminal').toBe(false);
  await maximizar.click({ timeout: 10_000 });
  await expect(terminal).toHaveClass(/maximized/);
});

test('abrir o terminal embaixo de um personagem já arrastado o tira do caminho', async ({ page, request }) => {
  // A ordem inversa: primeiro arrasta para o rodapé (onde, sem terminal, é lugar
  // legítimo), depois executa uma ferramenta. O terminal nasce POR BAIXO dele —
  // sem o evento de faixa, o Nino ficaria parado em cima dos botões.
  const conta = await criarConta(request, { modelo: 'ferramentas-lentas' });
  await abrirLogado(page, request, conta);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible();
  await page.waitForTimeout(250);

  const campoBox = await page.getByPlaceholder(ui.campoMensagem).boundingBox();
  await arrastarONino(page, { x: 1100, y: campoBox.y - 40 });

  await enviar(page, 'Rode o comando de teste.');
  const terminal = page.locator('.execDock');
  await expect(terminal).toBeVisible({ timeout: 60_000 });
  await terminal.getByRole('button', { name: 'Expandir o terminal' }).first().click();
  await expect(terminal).toHaveClass(/expanded/);
  await page.waitForTimeout(400);

  const cabecalho = await terminal.locator('.dockHead').boundingBox();
  const nino = await page.locator('.companionRoot').boundingBox();
  expect(Math.round(nino.y + nino.height), 'o personagem ficou sobre o cabeçalho do terminal')
    .toBeLessThanOrEqual(Math.round(cabecalho.y));
});
