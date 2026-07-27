// Exportação da apresentação para .pptx (PowerPoint/Google Slides/LibreOffice).
//
// O .pptx sai do JSON de slides, não do HTML do deck: um arquivo do PowerPoint
// é feito de CAIXAS DE TEXTO, e extrair caixas de volta de um HTML arbitrário
// seria adivinhação. Como o modelo já devolve a estrutura (`{slides:[...]}`),
// cada layout vira aqui um posicionamento explícito — e o mesmo JSON continua
// gerando o preview e o PDF.
//
// Limite honesto: o .pptx é uma tradução APROXIMADA do deck. Fontes, sombras e
// gradientes do CSS não têm equivalente exato no OOXML; o que é preservado é o
// conteúdo, a hierarquia (título/corpo/marcadores), a paleta e as notas do
// apresentador. Para fidelidade visual total, o PDF é o formato certo.
import { parseSlideBody, splitColumns } from './render.js';

// Medidas do layout 16:9 do pptxgenjs (10 × 5,625 polegadas).
const W = 10, H = 5.625;
const MARGIN = 0.6;
const DEFAULT_PRIMARY = '1F3B8A';
const DEFAULT_SECONDARY = 'E8523F';

// pptxgenjs quer a cor sem '#'. As cores já chegam validadas como hex por
// `sanitizeColor`; aqui só tiramos o '#' e normalizamos para 6 dígitos.
export function toPptxColor(value, fallback) {
  const hex = String(value || '').replace('#', '').trim();
  if (/^[0-9a-f]{6}$/i.test(hex)) return hex.toUpperCase();
  if (/^[0-9a-f]{3}$/i.test(hex)) return hex.split('').map(c => c + c).join('').toUpperCase();
  return fallback;
}

// Blocos do corpo -> runs de texto do pptxgenjs. Marcador vira bullet de
// verdade (não um "- " digitado), que é o que permite reformatar no PowerPoint.
export function bodyRuns(body, { fontSize = 16, color = '333333' } = {}) {
  const runs = [];
  for (const block of parseSlideBody(body)) {
    if (block.type === 'list') {
      for (const item of block.items) {
        runs.push({ text: item, options: { bullet: true, fontSize, color, breakLine: true } });
      }
    } else {
      runs.push({ text: block.text, options: { fontSize, color, breakLine: true, paraSpaceAfter: 6 } });
    }
  }
  return runs.length ? runs : [{ text: '', options: { fontSize, color } }];
}

function addSlide(pptx, slide, palette) {
  const s = pptx.addSlide();
  const { primary, secondary } = palette;
  const titleFont = palette.fontHeading || undefined;
  const bodyFont = palette.fontBody || undefined;

  if (slide.layout === 'image-full') {
    // Sem imagem real (o modelo devolve texto): o destaque em tela cheia é um
    // painel na cor primária, o mesmo que o deck HTML faz.
    s.background = { color: primary };
    if (slide.title) {
      s.addText(slide.title, {
        x: MARGIN, y: H - 2.6, w: W - MARGIN * 2, h: 1.1,
        fontSize: 36, bold: true, color: 'FFFFFF', fontFace: titleFont,
      });
    }
    s.addText(bodyRuns(slide.body, { fontSize: 16, color: 'FFFFFF' }), {
      x: MARGIN, y: H - 1.5, w: W - MARGIN * 2, h: 1.0, fontFace: bodyFont,
    });
  } else if (slide.layout === 'title') {
    if (slide.title) {
      s.addText(slide.title, {
        x: MARGIN, y: 1.7, w: W - MARGIN * 2, h: 1.4,
        fontSize: 40, bold: true, color: primary, align: 'center', fontFace: titleFont,
      });
    }
    s.addText(bodyRuns(slide.body, { fontSize: 18, color: '5B6474' }), {
      x: MARGIN + 0.6, y: 3.1, w: W - (MARGIN + 0.6) * 2, h: 1.4, align: 'center', fontFace: bodyFont,
    });
    // Fio na cor secundária: a mesma marca visual do <h2> do deck.
    s.addShape(pptx.ShapeType.rect, { x: W / 2 - 0.6, y: 3.0, w: 1.2, h: 0.05, fill: { color: secondary } });
  } else if (slide.layout === 'two-column') {
    const [left, right] = splitColumns(slide.body);
    if (slide.title) {
      s.addText(slide.title, {
        x: MARGIN, y: 0.5, w: W - MARGIN * 2, h: 0.8,
        fontSize: 28, bold: true, color: primary, fontFace: titleFont,
      });
      s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 1.32, w: 0.9, h: 0.05, fill: { color: secondary } });
    }
    const colW = (W - MARGIN * 2 - 0.5) / 2;
    s.addText(bodyRuns(left), { x: MARGIN, y: 1.7, w: colW, h: H - 2.3, valign: 'top', fontFace: bodyFont });
    s.addText(bodyRuns(right), { x: MARGIN + colW + 0.5, y: 1.7, w: colW, h: H - 2.3, valign: 'top', fontFace: bodyFont });
  } else {
    if (slide.title) {
      s.addText(slide.title, {
        x: MARGIN, y: 0.5, w: W - MARGIN * 2, h: 0.8,
        fontSize: 28, bold: true, color: primary, fontFace: titleFont,
      });
      s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 1.32, w: 0.9, h: 0.05, fill: { color: secondary } });
    }
    s.addText(bodyRuns(slide.body), {
      x: MARGIN, y: 1.7, w: W - MARGIN * 2, h: H - 2.3, valign: 'top', fontFace: bodyFont,
    });
  }

  if (slide.notes) s.addNotes(slide.notes);
  return s;
}

// Gera o .pptx a partir dos slides já normalizados. Devolve um Buffer, ou null
// se a biblioteca não estiver instalada neste ambiente (mesmo contrato
// best-effort do PDF — a rota responde com uma mensagem clara).
export async function slidesToPptx(slides, { title = 'Apresentação', designSystem = null } = {}) {
  let PptxGenJS;
  try {
    const mod = await import('pptxgenjs');
    PptxGenJS = mod.default || mod;
  } catch {
    return null;
  }

  const ds = designSystem || {};
  const palette = {
    primary: toPptxColor(ds.primaryColor, DEFAULT_PRIMARY),
    secondary: toPptxColor(ds.secondaryColor, DEFAULT_SECONDARY),
    fontHeading: ds.fontHeading || null,
    fontBody: ds.fontBody || null,
  };

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = title;
  for (const slide of (Array.isArray(slides) ? slides : [])) addSlide(pptx, slide, palette);

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
