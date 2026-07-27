// Impressão do artefato de design em PDF, com o Chromium headless.
//
// Reusa `getBrowser`/`guardRoute`/`scheduleIdleClose` do agent/pageShot.js DE
// PROPÓSITO. O HTML impresso aqui é código gerado por IA a partir do pedido do
// usuário — ou seja, não confiável — e ele roda no navegador DO BACKEND. Sem a
// mesma guarda de rede, uma página com `<img src="http://169.254.169.254/...">`
// usaria esse navegador para alcançar a rede interna (SSRF). A guarda do
// pageShot já resolve isso, inclusive a armadilha do Playwright de não chamar
// o `route()` no destino de um redirecionamento — copiar o código seria copiar
// a defesa e, mais cedo ou mais tarde, deixar a cópia para trás.
//
// A exportação é BEST-EFFORT no mesmo espírito da miniatura: sem o binário do
// Chromium, devolvemos null e a rota responde com uma mensagem clara, em vez
// de derrubar a requisição.
import { getBrowser, guardRoute, scheduleIdleClose } from '../agent/pageShot.js';

const TIMEOUT_MS = Math.max(5000, Number(process.env.DESIGN_PDF_TIMEOUT_MS || 25_000));

// Formato de página por tipo de saída. `preferCSSPageSize` deixa o @page do
// próprio artefato mandar quando ele define um (o documento gerado pela IA
// costuma declarar A4; o deck de slides declara 1280×720).
const PAGE = {
  document: { format: 'A4', printBackground: true, preferCSSPageSize: true },
  slides: { width: '1280px', height: '720px', printBackground: true, preferCSSPageSize: true },
  web: { format: 'A4', printBackground: true, preferCSSPageSize: true },
};

export function pdfOptionsFor(outputType) {
  return PAGE[outputType] || PAGE.web;
}

// Converte HTML autocontido em PDF. Devolve um Buffer, ou null quando o
// navegador não está disponível neste ambiente.
export async function htmlToPdf(html, outputType = 'web') {
  const browser = await getBrowser();
  if (!browser) return null;

  let page = null;
  try {
    // newPage() abre um contexto próprio: nada de estado compartilhado entre
    // uma exportação e a seguinte.
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route('**/*', guardRoute);
    // setContent parte de about:blank — o documento fica em origem opaca, sem
    // acesso a nada do backend, e nenhuma navegação de topo acontece.
    await page.setContent(String(html || ''), { waitUntil: 'load', timeout: TIMEOUT_MS });
    // Fontes/CSS de CDN chegam depois do `load`; sem essa folga o PDF sai com a
    // fonte de fallback. Curta de propósito: `networkidle` trava quando a
    // página tem qualquer coisa em polling.
    await page.waitForTimeout(600);
    return await page.pdf({ ...pdfOptionsFor(outputType), timeout: TIMEOUT_MS });
  } catch (err) {
    console.error('[design] falha ao gerar PDF:', err?.message);
    return null;
  } finally {
    try { if (page) await page.close(); } catch {}
    scheduleIdleClose();
  }
}
