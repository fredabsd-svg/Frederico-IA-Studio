// Elementos visuais (gráficos, assinaturas, selos, comprovantes): o Docling
// extrai as figuras como imagens; aqui montamos (a) uma nota transparente para
// o modelo saber o que existe e em quais páginas, e (b) as partes image_url para
// um modelo COM VISÃO realmente analisar. Nunca substituímos silenciosamente uma
// imagem por um marcador vazio (seção "Imagens, gráficos e elementos visuais").
import fs from 'node:fs';

const VISION_MAX_PICTURES = Math.max(1, Number(process.env.DOCLING_VISION_MAX_PICTURES || 4));

// Só as figuras que têm imagem renderizada podem ir para um modelo com visão.
export function selectPicturesForVision(pictures, max = VISION_MAX_PICTURES) {
  return (Array.isArray(pictures) ? pictures : [])
    .filter(p => p && p.file)
    .slice(0, max);
}

// Nota transparente listando os elementos visuais e suas páginas. `hasVision`
// muda o texto: com visão, dizemos que as imagens seguem anexadas; sem visão,
// AVISAMOS que o modelo não consegue interpretá-las com segurança (nada de
// fingir que leu um gráfico/assinatura).
export function visualElementsNote(pictures, hasVision) {
  const list = Array.isArray(pictures) ? pictures : [];
  if (!list.length) return null;
  const pages = [...new Set(list.map(p => p.page).filter(v => v != null))].sort((a, b) => a - b);
  const unrendered = list.filter(p => !p.file).length;
  const pagePart = pages.length ? ` (páginas ${pages.join(', ')})` : '';
  const lines = [`ELEMENTOS VISUAIS: o documento tem ${list.length} figura(s)/gráfico(s)/assinatura(s)${pagePart}.`];
  if (hasVision) {
    lines.push('As imagens desses elementos seguem anexadas — analise-as diretamente e cite a página correspondente.');
  } else {
    lines.push('O modelo atual NÃO tem visão: não é possível interpretar esses elementos visuais com segurança. Não descreva o conteúdo deles como se o tivesse lido; se forem necessários, avise o usuário para usar um modelo com visão.');
  }
  if (unrendered) {
    lines.push(`${unrendered} elemento(s) não puderam ser renderizados — sinalize isso em vez de inventar o conteúdo.`);
  }
  return lines.join(' ');
}

// Partes image_url (base64) a partir dos PNGs persistidos das figuras.
export function doclingImageParts(pictures, max = VISION_MAX_PICTURES) {
  const parts = [];
  for (const p of selectPicturesForVision(pictures, max)) {
    try {
      const b64 = fs.readFileSync(p.file).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
    } catch { /* arquivo sumiu: ignora esta figura */ }
  }
  return parts;
}
