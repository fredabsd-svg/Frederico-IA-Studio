// Modo Desenvolvedor — Smart Auto-scroll, perguntas interativas e terminal.
//
// Estes três só se provam com navegador de verdade: dependem de altura de
// viewport, de posição de rolagem e de foco. Nada aqui fala com provedor real —
// `fixtures/provedorFalso.mjs` traz os comportamentos determinísticos
// (`eco-longo`, `pergunta-*`, `ferramentas-lentas`).
import { test, expect, criarConta, abrirLogado, enviar, ui } from '../fixtures/app.js';

const AREA_MENSAGENS = '.messages';
const BOTAO_IR_AO_FIM = '.chatJump';
const CARTAO_PERGUNTA = '.inputReqCard';
const MODAL_PERGUNTA = '.inputReqDialog';
const TERMINAL = '.execDock';

const distanciaDoFim = (page) => page.locator(AREA_MENSAGENS).evaluate(
  el => el.scrollHeight - el.scrollTop - el.clientHeight
);
const posicao = (page) => page.locator(AREA_MENSAGENS).evaluate(el => el.scrollTop);
// Quanto de conteúdo já passa da altura visível. Antes de cobrar rolagem é
// preciso HAVER o que rolar — senão o teste mediria nada e passaria por acidente.
const excedente = (page) => page.locator(AREA_MENSAGENS).evaluate(el => el.scrollHeight - el.clientHeight);
const esperarConteudoRolavel = (page) =>
  expect.poll(() => excedente(page), { timeout: 60_000 }).toBeGreaterThan(200);

// Sobe a conversa de forma DETERMINÍSTICA: dispara o `wheel` para cima (o evento
// real que o app escuta para reconhecer a intenção) e posiciona a rolagem numa
// altura conhecida.
//
// Por que não `page.mouse.wheel`: o Chromium ANIMA a rolagem da roda, e a
// animação disputa com os deltas que continuam chegando — o teste passava a medir
// o assentamento da animação, não o comportamento do app. O evento sintético
// exercita exatamente o mesmo ouvinte (`onWheel` → pauseFollowing), sem a
// animação no meio.
// Devolve as medidas TIRADAS DENTRO DA PÁGINA, no mesmo passo: sem elas, uma
// leitura posterior não distingue "o app me arrastou de volta" de "não havia
// espaço para subir".
const subirConversa = (page, topo = 120) => page.locator(AREA_MENSAGENS).evaluate((el, top) => {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
  el.scrollTop = top;
  return {
    topoAplicado: el.scrollTop,
    excedente: el.scrollHeight - el.clientHeight,
    distanciaDoFim: el.scrollHeight - el.scrollTop - el.clientHeight
  };
}, topo);

// ═══════════════════════════════════════════════════════════════════════════
// SMART AUTO-SCROLL
// ═══════════════════════════════════════════════════════════════════════════

test('auto-scroll: no fim da conversa, acompanha o streaming', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco-longo' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Escreva a resposta longa.');

  // O fim precisa permanecer visível enquanto o texto cresce, e a rolagem tem de
  // AVANÇAR (senão o app estaria só parado no topo).
  await esperarConteudoRolavel(page);
  const inicio = await posicao(page);
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('Bloco 22', { timeout: 60_000 });
  const depois = await posicao(page);
  expect(depois, 'a rolagem deveria ter avançado junto com o streaming').toBeGreaterThan(inicio);
  await expect.poll(() => distanciaDoFim(page), { timeout: 30_000 }).toBeLessThanOrEqual(80);
});

test('auto-scroll: subir durante o streaming NÃO puxa o usuário de volta', async ({ page, request }) => {
  // A REGRESSÃO EXATA: o efeito antigo chamava scrollIntoView({behavior:'smooth'})
  // a cada delta. A animação reiniciava dezenas de vezes por segundo e arrastava
  // de volta quem tentava reler algo no meio da resposta.
  const conta = await criarConta(request, { modelo: 'eco-longo' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Escreva a resposta longa.');
  await esperarConteudoRolavel(page);

  // Sobe com a RODA do mouse (é a intenção que o app tem de reconhecer na hora).
  const aoSubir = await subirConversa(page, 120);
  expect(aoSubir.distanciaDoFim, `não havia espaço para subir (excedente ${aoSubir.excedente}px)`).toBeGreaterThan(80);
  const marcado = await posicao(page);
  expect(await distanciaDoFim(page), 'o app trouxe o usuário de volta ao fim logo após ele subir').toBeGreaterThan(80);

  // Deltas continuam chegando; a posição do usuário tem de ser respeitada.
  await page.waitForTimeout(2500);
  const agora = await posicao(page);
  expect(Math.abs(agora - marcado), 'a rolagem do usuário foi sequestrada durante o streaming').toBeLessThanOrEqual(8);

  // E o app avisa que há conteúdo novo abaixo, em vez de descer sozinho.
  await expect(page.locator(BOTAO_IR_AO_FIM)).toBeVisible({ timeout: 15_000 });
});

test('auto-scroll: "Ir para o final" retoma o acompanhamento', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco-longo' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Escreva a resposta longa.');
  await esperarConteudoRolavel(page);
  await subirConversa(page, 80);
  const botao = page.locator(BOTAO_IR_AO_FIM);
  await expect(botao).toBeVisible({ timeout: 15_000 });

  await botao.click();
  await expect.poll(() => distanciaDoFim(page), { timeout: 15_000 }).toBeLessThanOrEqual(80);
  // Retomou de verdade: os deltas seguintes continuam sendo acompanhados.
  await page.waitForTimeout(1500);
  await expect.poll(() => distanciaDoFim(page), { timeout: 30_000 }).toBeLessThanOrEqual(80);
  await expect(botao).toBeHidden({ timeout: 20_000 });
});

test('auto-scroll: enviar uma mensagem força o acompanhamento uma vez', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'eco' });
  await abrirLogado(page, request, conta);

  // Enche a conversa para haver o que rolar.
  for (const texto of ['PRIMEIRA MENSAGEM', 'SEGUNDA MENSAGEM', 'TERCEIRA MENSAGEM', 'QUARTA MENSAGEM']) {
    await enviar(page, texto);
    await expect(page.locator(ui.mensagensAssistente).last()).toContainText(texto, { timeout: 60_000 });
  }
  // Vai para o topo e confirma que ficou longe do fim.
  await subirConversa(page, 0);
  await page.waitForTimeout(150);

  await enviar(page, 'QUINTA MENSAGEM');
  await expect.poll(() => distanciaDoFim(page), { timeout: 20_000 }).toBeLessThanOrEqual(80);
  await expect(page.locator(ui.mensagensUsuario).last()).toContainText('QUINTA MENSAGEM');
});

// ═══════════════════════════════════════════════════════════════════════════
// PERGUNTAS INTERATIVAS
// ═══════════════════════════════════════════════════════════════════════════

test('pergunta de texto: abre a interface própria e NÃO aparece como erro', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'pergunta-texto' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Gere o relatorio do mes.');

  await expect(page.locator(MODAL_PERGUNTA)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(MODAL_PERGUNTA)).toContainText('formato');
  await expect(page.locator(MODAL_PERGUNTA)).toHaveAttribute('aria-modal', 'true');
  // Um pedido de decisão nunca é falha técnica: nada de "Reenviar" nem de toast
  // de erro na tela.
  await expect(page.getByRole('button', { name: 'Reenviar' })).toHaveCount(0);
  await expect(page.locator('.toast.err')).toHaveCount(0);
  await expect(page.locator(CARTAO_PERGUNTA)).toContainText('Aguardando sua resposta');

  // Fechar o modal NÃO descarta: o cartão inline permanece com "Responder".
  await page.keyboard.press('Escape');
  await expect(page.locator(MODAL_PERGUNTA)).toHaveCount(0);
  await expect(page.locator(CARTAO_PERGUNTA)).toBeVisible();

  // A solicitação sobrevive ao RELOAD (vem do execution_meta, não da memória).
  await page.reload();
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });
  const naBarra = page.locator(ui.itemConversa).filter({ hasText: 'Gere o relatorio' });
  await naBarra.first().click();
  await expect(page.locator(CARTAO_PERGUNTA)).toContainText('Aguardando sua resposta', { timeout: 30_000 });
  // Reabrir também não duplica o cartão.
  await expect(page.locator(CARTAO_PERGUNTA)).toHaveCount(1);

  // Responder vira mensagem do usuário e o turno seguinte continua o trabalho.
  await page.locator(CARTAO_PERGUNTA).getByRole('button', { name: 'Responder' }).click();
  await page.locator(`${MODAL_PERGUNTA} textarea`).fill('XLSX');
  await page.locator(MODAL_PERGUNTA).getByRole('button', { name: /Enviar resposta/ }).click();
  await expect(page.locator(ui.mensagensUsuario).last()).toContainText('XLSX', { timeout: 30_000 });
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('sigo com a sua escolha', { timeout: 60_000 });
  // Respondida, a pergunta deixa de aparecer como pendente.
  await expect(page.locator(CARTAO_PERGUNTA).filter({ hasText: 'Aguardando sua resposta' })).toHaveCount(0);
});

test('pergunta de confirmação: dois botões, e cancelar não é erro', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'pergunta-confirmacao' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Implemente a correcao.');
  const modal = page.locator(MODAL_PERGUNTA);
  await expect(modal).toBeVisible({ timeout: 60_000 });
  await expect(modal.getByRole('button', { name: /Enviar e abrir PR/ })).toBeVisible();
  await expect(modal.getByRole('button', { name: /Manter apenas localmente/ })).toBeVisible();

  await modal.getByRole('button', { name: /Manter apenas localmente/ }).click();
  await expect(page.locator(ui.mensagensUsuario).last()).toContainText('Manter apenas localmente', { timeout: 30_000 });
  await expect(page.locator('.toast.err')).toHaveCount(0);
});

test('pergunta de seleção: mostra as opções e só envia com uma escolhida', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'pergunta-selecao' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Corrija o defeito do login.');
  const modal = page.locator(MODAL_PERGUNTA);
  await expect(modal).toBeVisible({ timeout: 60_000 });
  const opcoes = modal.locator('.inputReqOption');
  await expect(opcoes).toHaveCount(2);
  await expect(opcoes.first()).toContainText('Correcao minima');
  await expect(opcoes.first()).toContainText('Altera apenas o defeito');

  await opcoes.nth(1).click();
  await expect(opcoes.nth(1)).toHaveAttribute('aria-checked', 'true');
  await modal.getByRole('button', { name: /Enviar resposta/ }).click();
  await expect(page.locator(ui.mensagensUsuario).last()).toContainText('Refatoracao completa', { timeout: 30_000 });
});

test('perguntas não se misturam entre conversas', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'pergunta-texto' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'PRIMEIRA TAREFA com pergunta.');
  await expect(page.locator(MODAL_PERGUNTA)).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');

  // Conversa NOVA: a pergunta da outra não pode aparecer aqui.
  await page.locator(ui.botaoNovaConversa).click();
  await expect(page.locator(CARTAO_PERGUNTA)).toHaveCount(0);
  await expect(page.locator(MODAL_PERGUNTA)).toHaveCount(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// TERMINAL INFERIOR
// ═══════════════════════════════════════════════════════════════════════════

test('terminal: aparece ao executar ferramenta, sem cobrir o compositor', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'ferramentas-lentas' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Rode o comando de teste.');

  const terminal = page.locator(TERMINAL);
  await expect(terminal).toBeVisible({ timeout: 60_000 });
  // O balão NÃO recebe mais o cartão grande e vivo: só a linha compacta.
  await expect(page.locator('.esCard')).toHaveCount(0);
  await expect(page.locator('.execLine')).toHaveCount(1);

  // O compositor e o botão de enviar continuam visíveis e CLICÁVEIS — o terminal
  // reserva altura em vez de flutuar por cima.
  const campo = page.getByPlaceholder(ui.campoMensagem);
  await expect(campo).toBeVisible();
  const enviarBtn = page.getByRole('button', { name: ui.botaoEnviar });
  await expect(enviarBtn).toBeVisible();
  const caixaTerminal = await terminal.boundingBox();
  const caixaCampo = await campo.boundingBox();
  expect(caixaTerminal.y + caixaTerminal.height, 'o terminal invadiu o compositor')
    .toBeLessThanOrEqual(caixaCampo.y + 2);
});

test('terminal: recolhe, expande, maximiza e a altura persiste no reload', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'ferramentas-lentas' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Rode o comando de teste.');
  const terminal = page.locator(TERMINAL);
  await expect(terminal).toBeVisible({ timeout: 60_000 });

  // Começa recolhido (é o padrão: não rouba espaço de quem não pediu).
  await expect(terminal).toHaveClass(/collapsed/);
  await terminal.getByRole('button', { name: 'Expandir o terminal' }).first().click();
  await expect(terminal).toHaveClass(/expanded/);
  await expect(terminal.locator('.dockSteps')).toBeVisible();

  await terminal.getByRole('button', { name: 'Maximizar o terminal' }).click();
  await expect(terminal).toHaveClass(/maximized/);
  await terminal.getByRole('button', { name: 'Restaurar a altura' }).click();
  await expect(terminal).toHaveClass(/expanded/);

  // Redimensiona pelo TECLADO (a alternativa acessível ao arraste) e confere que
  // a altura ficou salva.
  const alca = terminal.locator('.dockHandle');
  await alca.focus();
  const antes = (await terminal.boundingBox()).height;
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => (await terminal.boundingBox()).height, { timeout: 10_000 }).toBeGreaterThan(antes + 20);
  const depois = (await terminal.boundingBox()).height;

  const salvo = await page.evaluate(() => ({
    estado: localStorage.getItem('fred_execution_dock_v1_state'),
    altura: Number(localStorage.getItem('fred_execution_dock_v1_height'))
  }));
  expect(salvo.estado).toBe('expanded');
  expect(Math.abs(salvo.altura - depois)).toBeLessThanOrEqual(8);

  // Depois de RECARREGAR, a preferência vale para a próxima execução. LIMITE
  // CONHECIDO: as etapas de ferramenta não são persistidas no banco (só o
  // resumo, em `execution_meta`), então reabrir uma conversa antiga não
  // reconstrói o terminal — o comportamento é o mesmo que o cartão de execução
  // sempre teve. O que o teste cobra é o que existe: a preferência de estado e
  // de altura sobrevive e é aplicada na execução seguinte.
  await page.reload();
  await expect(page.getByPlaceholder(ui.campoMensagem)).toBeVisible({ timeout: 30_000 });
  await enviar(page, 'Rode outro comando de teste.');
  const reaberto = page.locator(TERMINAL);
  await expect(reaberto).toBeVisible({ timeout: 60_000 });
  await expect(reaberto).toHaveClass(/expanded/);
  const alturaReaberta = (await reaberto.boundingBox()).height;
  expect(Math.abs(alturaReaberta - depois), 'a altura do terminal não persistiu').toBeLessThanOrEqual(8);
});

test('terminal: a sessão concluída pode ser reaberta pelo histórico', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'ferramentas-lentas' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'Rode o comando de teste.');
  await expect(page.locator(TERMINAL)).toBeVisible({ timeout: 60_000 });
  // Espera a execução terminar (a linha do histórico deixa de dizer "andamento").
  await expect(page.locator('.execLine')).toContainText(/Execução (concluída|concluída com avisos|interrompida)/, { timeout: 90_000 });

  await page.locator('.execLine').getByRole('button', { name: 'Ver detalhes' }).click();
  const terminal = page.locator(TERMINAL);
  await expect(terminal).toBeVisible();
  await expect(terminal.locator('.dockStatus')).toContainText(/Concluído|Interrompido/);
});

test('terminal: conversa diferente não recebe os logs da outra', async ({ page, request }) => {
  const conta = await criarConta(request, { modelo: 'ferramentas-lentas' });
  await abrirLogado(page, request, conta);

  await enviar(page, 'PRIMEIRA execucao.');
  await expect(page.locator(TERMINAL)).toBeVisible({ timeout: 60_000 });

  await page.locator(ui.botaoNovaConversa).click();
  // Sem execução nesta conversa, não há terminal — e nenhuma etapa vazada.
  await expect(page.locator(TERMINAL)).toHaveCount(0);
  await expect(page.locator('.execLine')).toHaveCount(0);
});
