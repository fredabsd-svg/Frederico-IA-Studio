// Ver playwright.capturas.config.js — este arquivo gera imagens, não verifica comportamento.
import { test, expect, criarConta, abrirLogado, enviar, ui } from '../fixtures/app.js';
const OUT = new URL("../../frontend/public/landing", import.meta.url).pathname;
for (const tema of ['dark', 'light']) test(`captura do herói — ${tema}`, async ({ page, request }) => {
  await page.addInitScript(t => { try { localStorage.setItem('fred_theme', t); localStorage.setItem('fred_companion_min', '0'); } catch {} }, tema);
  const conta = await criarConta(request, { modelo: 'eco' });
  await page.setViewportSize({ width: 1280, height: 780 });
  await abrirLogado(page, request, conta);
  for (const t of ['Conferir DCTFWeb de agosto', 'Resumo do balancete trimestral', 'Proposta de honorários — cliente novo']) {
    await page.locator(ui.botaoNovaConversa).click();
    await enviar(page, t);
    await expect(page.locator(ui.mensagensAssistente).last()).toContainText(t.split(' ')[0], { timeout: 60_000 });
  }
  await page.locator(ui.botaoNovaConversa).click();
  await enviar(page, 'Monte a planilha de fluxo de caixa de setembro com os lançamentos do extrato anexo e destaque os dias com saldo negativo.');
  await expect(page.locator(ui.mensagensAssistente).last()).toContainText('fluxo de caixa', { timeout: 60_000 });
  await page.waitForTimeout(600);
  // Conteúdo ILUSTRATIVO da resposta (a página rotula a imagem como exemplo).
  await page.evaluate(() => {
    const msg = [...document.querySelectorAll('.msg.assistant')].pop();
    const texto = msg.querySelector('.md, .markdown, p')?.closest('div') || msg;
    const alvo = [...msg.children].find(el => !el.classList.contains('msgHead') && !el.classList.contains('msgActions') && !el.classList.contains('memoryTrace'));
    alvo.innerHTML = '<p>Pronto. Organizei os <b>47 lançamentos</b> do extrato por dia e categoria, com saldo acumulado e fórmulas conferidas.</p><ul><li>Saldo negativo em <b>3 dias</b> (12, 13 e 22/09), destacados em vermelho.</li><li>Maior saída: folha de pagamento, dia 05.</li><li>Aba <b>Resumo</b> com entradas × saídas por categoria.</li></ul>';
    const trace = msg.querySelector('.memoryTrace'); if (trace) trace.remove();
    msg.querySelectorAll('.retryBtn').forEach(el => el.remove());
    [...msg.querySelectorAll('p')].filter(p => /Não consegui concluir/.test(p.textContent)).forEach(p => p.remove());
    document.querySelectorAll('.toast').forEach(el => el.remove());
    const card = document.createElement('div'); card.className = 'filecards';
    card.innerHTML = '<a class="filecard" href="#"><span class="fcicon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h8M8 17h8M10 9H8"/></svg></span><span class="fcinfo"><b>fluxo-de-caixa-setembro.xlsx</b><small>18 KB · <span class="okBadge">✓ verificado (3 abas, fórmulas recalculadas)</span></small></span><span class="fcdl">Baixar</span></a>';
    msg.appendChild(card);
    const small = document.querySelector('.ctxBtnText small'); if (small) small.textContent = 'modelo escolhido · com ferramentas';
    const user = document.querySelector('.sideFootUser'); if (user) user.textContent = 'Minha conta';
    document.activeElement?.blur();
  });
  await page.mouse.move(5, 770);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/produto-${tema}.jpg`, type: 'jpeg', quality: 82 });
});
