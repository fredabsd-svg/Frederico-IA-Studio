// Núcleo PURO do Modo Design (sem banco, sem rede, sem navegador).
//
// Concentra o que precisa ser testável isoladamente: os prompts enviados ao
// modelo, a EXTRAÇÃO do artefato de dentro da resposta (que quase nunca vem
// limpa), a validação de que o conteúdo bate com o tipo de saída e a
// normalização das entradas vindas do cliente.
//
// A regra que sustenta o resto do módulo: **nada é persistido nem renderizado
// sem passar por `extractArtifact`**. O modelo é livre para responder o que
// quiser; o app só aceita um documento HTML completo (web/document) ou um JSON
// de slides no formato esperado. Um `output_type` que não bate com o conteúdo
// salvo é exatamente o tipo de confusão que faria o preview de uma apresentação
// renderizar JSON cru dentro de um iframe.

export const OUTPUT_TYPES = ['web', 'slides', 'document'];

// Limites de entrada. Não são regras de negócio sofisticadas — são o teto que
// impede um corpo de requisição gigante de virar uma chamada cara ao provedor.
export const MAX_TITLE_CHARS = 120;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_CONTENT_CHARS = 400_000;   // artefato guardado (HTML ou JSON)
// Teto do artefato ATUAL reenviado ao modelo numa edição. Acima disso a edição
// incremental deixa de caber com folga no contexto da maioria dos modelos —
// preferimos recusar com uma mensagem clara a mandar um HTML truncado, que
// volta como um documento quebrado (e o usuário perde a versão boa).
export const MAX_EDIT_CONTEXT_CHARS = 120_000;
export const MAX_SLIDES = 60;
export const MAX_HISTORY = 12;              // trocas do chat do projeto no contexto

export const SLIDE_LAYOUTS = ['title', 'content', 'two-column', 'image-full'];

// ---- System prompt ---------------------------------------------------------

// Base comum a todos os tipos de saída. As regras específicas de cada tipo
// entram depois (ver `outputTypeRules`), para que o modelo não receba, por
// exemplo, instruções de responsividade mobile-first quando o pedido é uma
// apresentação em 16:9.
const BASE_RULES = [
  'Você é um assistente de design especializado em transformar descrições em',
  'linguagem natural em código visual pronto para uso: HTML, CSS e JavaScript',
  'autocontidos em um único arquivo (sem build step, sem dependências que',
  'exijam npm install — pode usar CDN para Tailwind CSS e Google Fonts).',
  '',
  'Regras:',
  '1. Sempre devolva um documento HTML completo e válido (<!DOCTYPE html>...).',
  '2. Design deve ser moderno, com hierarquia visual clara, bom contraste e',
  '   espaçamento consistente. Evite templates genéricos — tome decisões de',
  '   tipografia, cor e layout que caibam no pedido do usuário.',
  '3. Se um design system for fornecido (cores, fontes, componentes), use-o',
  '   rigorosamente em todo o resultado.',
  '4. Quando o pedido for uma EDIÇÃO de um design existente (o conteúdo atual',
  '   será fornecido), altere apenas o necessário para atender ao pedido — não',
  '   regenere do zero, preserve estrutura e conteúdo não mencionados.',
  '5. Nunca inclua explicações fora do código/JSON solicitado — a resposta',
  '   inteira deve ser o artefato pronto para renderizar.',
  '6. Escreva os textos do artefato em português do Brasil, salvo pedido',
  '   explícito em outro idioma.',
].join('\n');

// Regras específicas por tipo de saída.
const TYPE_RULES = {
  web: [
    'TIPO DE SAÍDA: web (página ou protótipo navegável).',
    '- Priorize responsividade mobile-first: o resultado tem de funcionar em',
    '  telas de 360px de largura sem rolagem horizontal.',
    '- JavaScript, quando houver, fica inline no próprio arquivo.',
    '- Não use formulários que enviem dados para fora nem chamadas de rede a',
    '  domínios que não sejam CDN de CSS/fontes.',
  ].join('\n'),
  slides: [
    'TIPO DE SAÍDA: slides (apresentação).',
    'Devolva APENAS um JSON válido no formato:',
    '{ "slides": [ { "layout": "title|content|two-column|image-full",',
    '  "title": "...", "body": "...", "notes": "..." }, ... ] }',
    '— sem HTML, sem comentários, sem cercas de código, sem texto fora do JSON.',
    `- No máximo ${MAX_SLIDES} slides.`,
    '- "body" aceita quebras de linha; cada linha iniciada por "- " vira um',
    '  marcador. No layout "two-column", separe as duas colunas com uma linha',
    '  contendo apenas "---".',
    '- "notes" são as notas do apresentador (não aparecem no slide).',
  ].join('\n'),
  document: [
    'TIPO DE SAÍDA: document (documento visual paginado, para leitura e impressão).',
    '- O HTML é para PAPEL, não para tela: use @page { size: A4; margin: 0 } e',
    '  um contêiner por página com 210mm × 297mm.',
    '- Inclua capa com título, hierarquia tipográfica clara, tabelas estilizadas',
    '  e, quando fizer sentido, cabeçalho/rodapé com numeração via CSS.',
    '- Evite qualquer coisa que dependa de interação: o destino é PDF.',
  ].join('\n'),
};

export function outputTypeRules(outputType) {
  return TYPE_RULES[outputType] || TYPE_RULES.web;
}

// Bloco que descreve o design system do usuário. Fora quando não há um — mandar
// "nenhum design system definido" só gasta token e convida o modelo a comentar.
export function designSystemBlock(ds) {
  if (!ds) return '';
  const lines = [];
  if (ds.name) lines.push(`Nome: ${ds.name}`);
  if (ds.primaryColor) lines.push(`Cor primária: ${ds.primaryColor}`);
  if (ds.secondaryColor) lines.push(`Cor secundária: ${ds.secondaryColor}`);
  if (ds.fontHeading) lines.push(`Fonte de títulos: ${ds.fontHeading}`);
  if (ds.fontBody) lines.push(`Fonte de corpo: ${ds.fontBody}`);
  if (ds.notes) lines.push(`Observações da marca: ${ds.notes}`);
  if (!lines.length) return '';
  return ['DESIGN SYSTEM DO USUÁRIO (use rigorosamente):', ...lines].join('\n');
}

export function buildSystemPrompt(outputType, designSystem = null) {
  return [BASE_RULES, outputTypeRules(outputType), designSystemBlock(designSystem)]
    .filter(Boolean)
    .join('\n\n');
}

const clamp = (v, max) => (v == null ? '' : String(v).slice(0, max));

// Monta as mensagens da chamada de geração/edição.
//
// `current` é o artefato da versão atual (vazio na primeira geração). O
// histórico do chat entra ENCURTADO e sem os artefatos — o modelo já recebe o
// conteúdo atual inteiro; repetir as versões anteriores multiplicaria o custo
// sem acrescentar informação.
export function buildGenerateMessages({
  outputType, prompt, current = '', designSystem = null, history = [], maxHistory = MAX_HISTORY,
} = {}) {
  const system = buildSystemPrompt(outputType, designSystem);
  const past = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-maxHistory)
    // As falas do assistente no chat do projeto são resumos curtos ("versão 3
    // criada"), não o artefato — mandá-las inteiras é barato e dá continuidade.
    .map(m => ({ role: m.role, content: clamp(m.content, 1000) }));

  const userParts = [];
  if (current) {
    userParts.push(
      outputType === 'slides'
        ? 'JSON DE SLIDES ATUAL (edite-o, não recomece):'
        : 'HTML ATUAL (edite-o, não recomece):',
      current,
      '',
      'PEDIDO DE MUDANÇA:',
    );
  }
  userParts.push(clamp(prompt, MAX_PROMPT_CHARS));

  return [
    { role: 'system', content: system },
    ...past,
    { role: 'user', content: userParts.join('\n') },
  ];
}

// ---- Extração do artefato --------------------------------------------------

// Remove uma cerca de código que envolva a resposta inteira (```html ... ```).
// Só desembrulha quando a cerca ABRE no começo do texto: um HTML que por acaso
// contenha ``` no meio (um bloco de código dentro da página gerada) não pode
// ser cortado ao meio por essa heurística.
export function stripCodeFence(raw) {
  const text = String(raw || '').trim();
  const opening = /^```[a-zA-Z0-9_-]*\s*\n/.exec(text);
  if (!opening) return text;
  const rest = text.slice(opening[0].length);
  const close = rest.lastIndexOf('```');
  return (close === -1 ? rest : rest.slice(0, close)).trim();
}

// Recorta o documento HTML de dentro de uma resposta com ruído (saudação antes,
// comentário depois). Devolve '' quando não há documento reconhecível.
export function extractHtmlDocument(raw) {
  const text = stripCodeFence(raw);
  const start = text.search(/<!DOCTYPE\s+html|<html[\s>]/i);
  if (start === -1) return '';
  const endTag = text.toLowerCase().lastIndexOf('</html>');
  const end = endTag === -1 ? text.length : endTag + '</html>'.length;
  return text.slice(start, end).trim();
}

// Recorta o objeto JSON de dentro de uma resposta com ruído. Procura o primeiro
// '{' e casa as chaves — ignorando as que estejam DENTRO de string, senão um
// título como "Plano { A }" desbalanceia a contagem e o recorte sai errado.
export function extractJsonObject(raw) {
  const text = stripCodeFence(raw);
  const start = text.indexOf('{');
  if (start === -1) return '';
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

// Normaliza um slide vindo do modelo. Campos desconhecidos são descartados e o
// layout cai em 'content' quando não é um dos suportados pelo renderizador —
// um layout inventado renderizaria uma página em branco.
export function normalizeSlide(slide) {
  const s = slide && typeof slide === 'object' ? slide : {};
  const layout = SLIDE_LAYOUTS.includes(s.layout) ? s.layout : 'content';
  return {
    layout,
    title: clamp(s.title, 300),
    body: clamp(s.body, 6000),
    notes: clamp(s.notes, 3000),
  };
}

// Valida e normaliza o JSON de slides. Devolve { ok, slides, error }.
export function parseSlidesJson(raw) {
  const json = extractJsonObject(raw);
  if (!json) return { ok: false, error: 'A resposta não trouxe um JSON de slides.' };
  let parsed;
  try { parsed = JSON.parse(json); }
  catch { return { ok: false, error: 'O JSON de slides devolvido é inválido.' }; }
  const list = Array.isArray(parsed?.slides) ? parsed.slides : null;
  if (!list) return { ok: false, error: 'O JSON precisa ter a chave "slides" com uma lista.' };
  if (!list.length) return { ok: false, error: 'A apresentação veio sem nenhum slide.' };
  return { ok: true, slides: list.slice(0, MAX_SLIDES).map(normalizeSlide) };
}

// Porta única entre a resposta do modelo e o banco: transforma o texto cru no
// artefato que será persistido, ou explica por que não dá.
export function extractArtifact(raw, outputType) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'O modelo respondeu vazio.' };

  if (outputType === 'slides') {
    const parsed = parseSlidesJson(text);
    if (!parsed.ok) return parsed;
    const content = JSON.stringify({ slides: parsed.slides });
    if (content.length > MAX_CONTENT_CHARS) return { ok: false, error: 'A apresentação gerada ficou grande demais.' };
    return { ok: true, content };
  }

  const html = extractHtmlDocument(text);
  if (!html) return { ok: false, error: 'A resposta não trouxe um documento HTML completo.' };
  if (html.length > MAX_CONTENT_CHARS) return { ok: false, error: 'O documento gerado ficou grande demais.' };
  return { ok: true, content: html };
}

// Confere que o conteúdo GUARDADO ainda bate com o tipo de saída antes de
// renderizar/exportar. Parece redundante depois de `extractArtifact`, mas o
// tipo e o conteúdo são colunas independentes: uma migração futura, um restore
// de backup ou um bug de escrita podem descasar as duas — e o preço de
// renderizar JSON como HTML dentro do iframe é alto demais para confiar.
export function contentMatchesType(content, outputType) {
  const text = String(content || '');
  if (!text.trim()) return false;
  if (outputType === 'slides') return parseSlidesJson(text).ok;
  if (!OUTPUT_TYPES.includes(outputType)) return false;
  return /^\s*(<!DOCTYPE\s+html|<html[\s>])/i.test(text);
}

// ---- Normalização das entradas do cliente ----------------------------------

export function sanitizeProjectInput(input = {}) {
  const title = clamp(input.title, MAX_TITLE_CHARS).trim();
  const outputType = OUTPUT_TYPES.includes(input.outputType) ? input.outputType : 'web';
  const designSystemId = input.designSystemId ? clamp(input.designSystemId, 120).trim() : null;
  return { title: title || defaultTitle(outputType), outputType, designSystemId: designSystemId || null };
}

export function defaultTitle(outputType) {
  return { web: 'Novo site', slides: 'Nova apresentação', document: 'Novo documento' }[outputType] || 'Novo projeto';
}

// Cor aceita: hex de 3 ou 6 dígitos. Qualquer outra coisa vira null — a cor é
// interpolada em CSS no HTML do deck, então um valor livre aqui seria injeção
// de estilo (e, com `expression()`/`url()`, de conteúdo) no documento gerado.
export function sanitizeColor(value) {
  const v = clamp(value, 20).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : null;
}

// Nome de fonte aceita letras, números, espaço e alguns separadores — o valor
// vai para `font-family` e para a URL do Google Fonts. Sem isso, aspas ou `;`
// escapariam da declaração CSS.
export function sanitizeFontName(value) {
  const v = clamp(value, 60).trim();
  return /^[\w\s.,'+-]+$/.test(v) ? v : null;
}

export function sanitizeDesignSystemInput(input = {}) {
  return {
    name: clamp(input.name, 80).trim() || 'Minha marca',
    primaryColor: sanitizeColor(input.primaryColor),
    secondaryColor: sanitizeColor(input.secondaryColor),
    fontHeading: sanitizeFontName(input.fontHeading),
    fontBody: sanitizeFontName(input.fontBody),
    notes: clamp(input.notes, 2000).trim() || null,
  };
}

// Resumo curto da mudança para a bolha do assistente no chat do projeto. O
// artefato inteiro não vai para o chat (é o preview que mostra o resultado).
export function versionSummary(outputType, versionNumber, content) {
  if (outputType === 'slides') {
    const parsed = parseSlidesJson(content);
    const n = parsed.ok ? parsed.slides.length : 0;
    return `Versão ${versionNumber} pronta — ${n} ${n === 1 ? 'slide' : 'slides'}.`;
  }
  const kb = Math.max(1, Math.round(String(content || '').length / 1024));
  return `Versão ${versionNumber} pronta — ${kb} KB de HTML.`;
}

export const EXPORT_FORMATS = {
  web: ['html'],
  slides: ['html', 'pdf', 'pptx'],
  document: ['html', 'pdf'],
};

// Formato pedido → formato efetivo (o primeiro da lista é o padrão do tipo).
export function resolveExportFormat(outputType, requested) {
  const allowed = EXPORT_FORMATS[outputType] || EXPORT_FORMATS.web;
  const want = String(requested || '').trim().toLowerCase();
  return allowed.includes(want) ? want : allowed[0];
}

// Nome de arquivo seguro a partir do título do projeto (o título é livre e vai
// para o cabeçalho Content-Disposition).
export function safeFileName(title, extension) {
  const base = String(title || 'design')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${base || 'design'}.${extension}`;
}
