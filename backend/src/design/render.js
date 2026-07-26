// Renderização determinística do Modo Design (pura: string entra, string sai).
//
// O que é gerado AQUI e não pela IA: o HTML da apresentação. O modelo devolve
// apenas a estrutura (`{slides:[...]}`) e este módulo a transforma em um deck
// autocontido. A separação é de propósito:
//
//   * o mesmo JSON vira preview na tela, PDF impresso e .pptx exportado — se o
//     modelo devolvesse HTML de slides, o .pptx teria de ser extraído de volta
//     de um HTML arbitrário, o que não é confiável;
//   * o conteúdo do usuário/modelo é ESCAPADO ao entrar no HTML. Num artefato
//     `web` o HTML é do modelo e roda numa origem opaca (é essa a razão do
//     sandbox); já no deck o esqueleto é nosso, então nada de texto do modelo
//     pode virar marcação.
//
// O deck não usa CDN nem fonte externa: ele precisa abrir offline depois de
// exportado, e o Chromium que gera o PDF roda sem rede garantida.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// Paleta padrão do deck. Sobrescrita pelo design system do usuário quando há um
// (as cores já chegam validadas como hex por `sanitizeColor`).
const DEFAULT_PRIMARY = '#1f3b8a';
const DEFAULT_SECONDARY = '#e8523f';

// Fontes locais: pilha do sistema, sem download. Um deck exportado precisa
// abrir igual numa máquina sem internet.
const STACK_HEADING = "'Segoe UI Semibold', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const STACK_BODY = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";

// Quebra o corpo de um slide em blocos (parágrafos e listas de marcadores).
// Linha iniciada por "- " ou "• " é marcador; marcadores seguidos viram uma
// única lista, o que é o que faz o slide parecer um slide e não um texto.
export function parseSlideBody(body) {
  const lines = String(body || '').split(/\r?\n/);
  const blocks = [];
  let bullets = null;
  const flush = () => { if (bullets && bullets.length) blocks.push({ type: 'list', items: bullets }); bullets = null; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = /^([-*•])\s+(.*)$/.exec(line);
    if (bullet) { (bullets ||= []).push(bullet[2].trim()); continue; }
    flush();
    blocks.push({ type: 'text', text: line });
  }
  flush();
  return blocks;
}

// Divide o corpo nas duas colunas do layout "two-column". O separador é uma
// linha contendo apenas "---" (instruído no system prompt); sem ele, dividimos
// os blocos ao meio para que o layout ainda faça sentido.
export function splitColumns(body) {
  const text = String(body || '');
  const parts = text.split(/^\s*---\s*$/m);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join('\n')];
  const blocks = parseSlideBody(text);
  if (blocks.length < 2) return [text, ''];
  const half = Math.ceil(blocks.length / 2);
  const toText = list => list.map(b => (b.type === 'list' ? b.items.map(i => `- ${i}`).join('\n') : b.text)).join('\n\n');
  return [toText(blocks.slice(0, half)), toText(blocks.slice(half))];
}

function renderBlocks(body) {
  return parseSlideBody(body).map(block => (
    block.type === 'list'
      ? `<ul>${block.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
      : `<p>${escapeHtml(block.text)}</p>`
  )).join('');
}

function renderSlide(slide, index) {
  const title = escapeHtml(slide.title);
  const n = index + 1;
  const notes = slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : '';
  let inner;
  switch (slide.layout) {
    case 'title':
      inner = `<div class="center">${title ? `<h1>${title}</h1>` : ''}<div class="lead">${renderBlocks(slide.body)}</div></div>`;
      break;
    case 'two-column': {
      const [left, right] = splitColumns(slide.body);
      inner = `${title ? `<h2>${title}</h2>` : ''}<div class="cols"><div>${renderBlocks(left)}</div><div>${renderBlocks(right)}</div></div>`;
      break;
    }
    case 'image-full':
      // Sem imagem real: o modelo devolve texto, não binário. O layout entrega
      // um painel de destaque em tela cheia com a paleta do projeto — honesto
      // sobre o que existe, em vez de um espaço reservado vazio.
      inner = `<div class="hero">${title ? `<h1>${title}</h1>` : ''}<div class="lead">${renderBlocks(slide.body)}</div></div>`;
      break;
    default:
      inner = `${title ? `<h2>${title}</h2>` : ''}<div class="body">${renderBlocks(slide.body)}</div>`;
  }
  return `<section class="slide slide-${escapeHtml(slide.layout)}" data-slide="${n}" aria-label="Slide ${n}">`
    + `<div class="pad">${inner}</div><span class="num">${n}</span>${notes}</section>`;
}

const DECK_CSS = `
:root{--primary:%PRIMARY%;--secondary:%SECONDARY%;--ink:#12151c;--muted:#5b6474;--paper:#fff;
--font-heading:%FONT_HEADING%;--font-body:%FONT_BODY%}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#0e1117;color:var(--ink);font-family:var(--font-body)}
.deck{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px}
.slide{container-type:inline-size;position:relative;width:100%;max-width:1280px;aspect-ratio:16/9;
background:var(--paper);border-radius:10px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.45)}
.slide .pad{position:absolute;inset:0;padding:6cqw 7cqw;display:flex;flex-direction:column;justify-content:center}
h1{font-family:var(--font-heading);font-size:6.4cqw;line-height:1.08;margin:0 0 2cqw;color:var(--primary);letter-spacing:-.02em}
h2{font-family:var(--font-heading);font-size:4.4cqw;line-height:1.15;margin:0 0 3cqw;color:var(--primary);letter-spacing:-.015em}
h2::after{content:"";display:block;width:9cqw;height:.5cqw;background:var(--secondary);border-radius:1cqw;margin-top:1.6cqw}
p{font-size:2.5cqw;line-height:1.5;margin:0 0 1.4cqw;color:var(--ink)}
ul{margin:0 0 1.4cqw;padding-left:3.4cqw}
li{font-size:2.5cqw;line-height:1.5;margin-bottom:1.1cqw}
li::marker{color:var(--secondary)}
.lead p,.lead li{font-size:2.9cqw;color:var(--muted)}
.center{text-align:center;margin:auto}
.center h1{font-size:7.4cqw}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:5cqw;align-items:start}
.hero{position:absolute;inset:0;padding:7cqw;display:flex;flex-direction:column;justify-content:flex-end;
background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff}
.hero h1,.hero p,.hero li{color:#fff}
.num{position:absolute;right:3cqw;bottom:2.4cqw;font-size:1.6cqw;color:var(--muted);opacity:.75}
.slide-image-full .num{color:#fff}
.notes{display:none}
@media print{
  html,body{background:#fff}
  .deck{display:block;padding:0;gap:0}
  .slide{max-width:none;width:1280px;height:720px;aspect-ratio:auto;border-radius:0;box-shadow:none;
  break-after:page;page-break-after:always}
  .slide:last-child{break-after:auto;page-break-after:auto}
}
@page{size:1280px 720px;margin:0}
`;

// Navegação por teclado/clique no preview. Fica fora do CSS de impressão: no
// PDF todos os slides aparecem em sequência, aqui rolamos até o escolhido.
const DECK_JS = `
(function(){
  var slides=[].slice.call(document.querySelectorAll('.slide'));
  if(!slides.length)return;
  var i=0;
  function go(n){i=Math.max(0,Math.min(slides.length-1,n));slides[i].scrollIntoView({behavior:'smooth',block:'center'});}
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();go(i+1);}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();go(i-1);}
    else if(e.key==='Home'){e.preventDefault();go(0);}
    else if(e.key==='End'){e.preventDefault();go(slides.length-1);}
  });
  var io=new IntersectionObserver(function(entries){
    entries.forEach(function(en){if(en.isIntersecting)i=slides.indexOf(en.target);});
  },{threshold:.6});
  slides.forEach(function(s){io.observe(s);});
})();
`;

function deckCss(designSystem) {
  const ds = designSystem || {};
  return DECK_CSS
    .replace('%PRIMARY%', ds.primaryColor || DEFAULT_PRIMARY)
    .replace('%SECONDARY%', ds.secondaryColor || DEFAULT_SECONDARY)
    // A fonte já vem validada (`sanitizeFontName`); as aspas simples aqui são
    // o formato exigido pelo CSS para nomes com espaço.
    .replace('%FONT_HEADING%', ds.fontHeading ? `'${ds.fontHeading}', ${STACK_HEADING}` : STACK_HEADING)
    .replace('%FONT_BODY%', ds.fontBody ? `'${ds.fontBody}', ${STACK_BODY}` : STACK_BODY);
}

// Deck completo e autocontido a partir dos slides já normalizados.
export function renderSlidesDeck(slides, { title = 'Apresentação', designSystem = null } = {}) {
  const body = (Array.isArray(slides) ? slides : []).map(renderSlide).join('\n');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${deckCss(designSystem)}</style>
</head>
<body>
<main class="deck">
${body}
</main>
<script>${DECK_JS}</script>
</body>
</html>`;
}

// Página mostrada quando o projeto ainda não tem versão (ou o conteúdo salvo
// não bate com o tipo). Sem isso o iframe ficaria em branco e pareceria um erro
// de carregamento.
export function renderPlaceholder(message) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Prévia</title>
<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#0f1218;color:#9aa4b8;
font-family:'Segoe UI',Helvetica,Arial,sans-serif}p{max-width:28rem;text-align:center;line-height:1.6;padding:2rem}</style>
</head><body><p>${escapeHtml(message)}</p></body></html>`;
}
