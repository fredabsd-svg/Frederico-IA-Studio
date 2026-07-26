// Controles de ajuste do Modo Design: as variáveis CSS que o usuário pode
// mexer sem gastar uma chamada à IA. Módulo PURO (string entra, string sai).
//
// ─────────────────────────────────────────────────────────────────────────────
// Por que isto depende de um CONTRATO com o modelo, e não de "adivinhar o CSS"
//
// A ideia de um slider de "cor primária" só funciona se existir um lugar único
// onde a cor primária mora. Num HTML arbitrário ela está espalhada em vinte
// declarações, cada uma escrita de um jeito (`#1f3b8a`, `rgb(31,59,138)`,
// `bg-blue-900` do Tailwind). Reescrever isso por regex seria adivinhação: ora
// acertaria, ora pintaria o texto de fundo.
//
// Então o contrato é explícito: o system prompt EXIGE que o artefato declare um
// bloco `:root` com os nomes abaixo e os use no resto do CSS. O ajuste vira uma
// sobreposição de `:root` — três linhas de CSS, sem tocar no artefato.
//
// A consequência boa: a interface não precisa saber nada sobre o design. Ela
// pergunta ao artefato quais tokens ele declarou (`detectTokens`) e desenha um
// controle por token encontrado. Um design que declare só as duas cores mostra
// dois controles; um artefato antigo, gerado antes deste contrato, mostra zero —
// e a tela diz isso em vez de oferecer sliders que não fazem nada.
// ─────────────────────────────────────────────────────────────────────────────

// Catálogo fechado. Só o que está aqui pode ser lido do artefato ou gravado
// como ajuste — nome de variável não entra por texto livre em hipótese alguma,
// porque o valor vai direto para dentro de uma folha de estilo.
export const DESIGN_TOKENS = [
  { id: 'corPrimaria', cssVar: '--fred-cor-primaria', kind: 'cor', label: 'Cor primária', hint: 'Títulos, botões e destaques' },
  { id: 'corSecundaria', cssVar: '--fred-cor-secundaria', kind: 'cor', label: 'Cor secundária', hint: 'Detalhes e apoio' },
  { id: 'corTexto', cssVar: '--fred-cor-texto', kind: 'cor', label: 'Cor do texto', hint: 'Corpo do conteúdo' },
  { id: 'corFundo', cssVar: '--fred-cor-fundo', kind: 'cor', label: 'Cor de fundo', hint: 'Fundo da página' },
  { id: 'fonteBase', cssVar: '--fred-fonte-base', kind: 'medida', label: 'Tamanho do texto', hint: 'Base da escala tipográfica', unit: 'px', min: 12, max: 24, step: 0.5 },
  { id: 'espaco', cssVar: '--fred-espaco', kind: 'medida', label: 'Espaçamento', hint: 'Respiro entre os blocos', unit: 'rem', min: 0.5, max: 3, step: 0.1 },
  { id: 'raio', cssVar: '--fred-raio', kind: 'medida', label: 'Arredondamento', hint: 'Cantos de caixas e botões', unit: 'px', min: 0, max: 32, step: 1 },
];

const BY_ID = new Map(DESIGN_TOKENS.map(t => [t.id, t]));
const BY_VAR = new Map(DESIGN_TOKENS.map(t => [t.cssVar, t]));

export const tokenById = (id) => BY_ID.get(String(id)) || null;

// Trecho do system prompt que estabelece o contrato. Sem ele, o modelo escreve
// as cores direto nas regras e os controles não têm em que pegar.
export const TOKENS_PROMPT = [
  'CONTROLES DE AJUSTE (obrigatório em saídas HTML):',
  'Declare no início do CSS um bloco :root com estas variáveis e USE-AS em todo',
  'o restante do estilo, em vez de repetir valores literais:',
  '',
  ':root {',
  ...DESIGN_TOKENS.map(t => `  ${t.cssVar}: <valor>;   /* ${t.label.toLowerCase()} */`),
  '}',
  '',
  '- Cores em hexadecimal (#rrggbb). Tamanhos com unidade (px para',
  `  ${DESIGN_TOKENS.filter(t => t.unit === 'px').map(t => t.cssVar).join(' e ')}, rem para --fred-espaco).`,
  '- Derive o resto a partir delas: por exemplo',
  '  `padding: calc(var(--fred-espaco) * 2)` e',
  '  `font-size: calc(var(--fred-fonte-base) * 2.4)`.',
  '- É esse bloco que dá ao usuário sliders de cor, tipografia e espaçamento na',
  '  interface. Um design que não o declare perde esses controles.',
].join('\n');

// ---- Leitura do artefato ---------------------------------------------------

// Valor de uma variável dentro de um bloco `:root`. Regex é suficiente e
// proposital: não precisamos entender o CSS, só descobrir se a variável foi
// declarada e com que valor — e um parser de CSS inteiro seria uma dependência
// nova para responder a uma pergunta de uma linha.
function declaredValue(css, cssVar) {
  const re = new RegExp(`${cssVar}\\s*:\\s*([^;}]+)`, 'i');
  const found = re.exec(css);
  return found ? found[1].trim() : null;
}

// Tokens que ESTE artefato declara, com o valor que ele usa como padrão. É o
// que a interface transforma em controles.
export function detectTokens(html) {
  const text = String(html || '');
  const out = [];
  for (const token of DESIGN_TOKENS) {
    const raw = declaredValue(text, token.cssVar);
    if (raw == null) continue;
    const value = token.kind === 'cor' ? normalizeHex(raw) : parseMeasure(raw, token);
    if (value == null) continue;
    out.push({ ...token, defaultValue: value });
  }
  return out;
}

// ---- Validação dos valores -------------------------------------------------

// Hex de 3 ou 6 dígitos, normalizado para 6. Qualquer outra coisa é recusada:
// o valor é interpolado dentro de CSS, então `red; content:url(...)` não pode
// virar declaração.
export function normalizeHex(value) {
  const v = String(value == null ? '' : value).trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
}

// Número dentro da faixa do token. Aceita o valor com ou sem unidade (o CSS
// declara `16px`, o slider manda `16`) e devolve sempre o NÚMERO — a unidade é
// acrescentada na hora de montar o CSS, a partir do catálogo.
export function parseMeasure(value, token) {
  const num = Number.parseFloat(String(value == null ? '' : value).trim());
  if (!Number.isFinite(num)) return null;
  const min = token.min ?? 0;
  const max = token.max ?? 100;
  if (num < min || num > max) return Math.min(max, Math.max(min, num));
  return num;
}

// Normaliza o objeto de ajustes vindo do cliente. Tudo que não estiver no
// catálogo, ou não passar na validação do tipo, simplesmente some.
export function sanitizeAdjustments(input) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const token of DESIGN_TOKENS) {
    if (!(token.id in source)) continue;
    const raw = source[token.id];
    // null/'' apaga o ajuste e devolve o design ao valor que ele mesmo declara.
    if (raw == null || raw === '') continue;
    const value = token.kind === 'cor' ? normalizeHex(raw) : parseMeasure(raw, token);
    if (value == null) continue;
    out[token.id] = value;
  }
  return out;
}

// ---- Escrita do CSS --------------------------------------------------------

// Sobreposição de `:root` com os ajustes. Só sai CSS a partir de valores JÁ
// validados — nada do que o cliente mandou chega aqui em forma de texto.
export function buildOverrideCss(adjustments) {
  const clean = sanitizeAdjustments(adjustments);
  const lines = [];
  for (const token of DESIGN_TOKENS) {
    if (!(token.id in clean)) continue;
    const value = token.kind === 'cor' ? clean[token.id] : `${clean[token.id]}${token.unit || ''}`;
    lines.push(`  ${token.cssVar}: ${value};`);
  }
  if (!lines.length) return '';
  // `!important` porque o artefato pode redeclarar `:root` depois deste bloco
  // (um segundo <style>, um CDN carregado no fim). Sem isso, o ajuste do
  // usuário perderia para o valor que ele está justamente tentando trocar.
  return `:root{\n${lines.map(l => l.replace(/;$/, ' !important;')).join('\n')}\n}`;
}

export const ADJUSTMENTS_STYLE_ID = 'fred-ajustes';

// Injeta a sobreposição no HTML servido/exportado. Vai por ÚLTIMO no <head> —
// e, se não houver head, antes de </body> — para vencer o CSS do artefato pela
// ordem, além do !important.
//
// O artefato guardado no banco NÃO é alterado: o ajuste é uma camada aplicada
// na hora de renderizar. É o que permite mexer nos sliders, pedir uma edição no
// chat e continuar com os dois efeitos — o modelo edita a base, o ajuste segue
// por cima.
export function applyAdjustments(html, adjustments) {
  const css = buildOverrideCss(adjustments);
  if (!css) return String(html || '');
  const style = `<style id="${ADJUSTMENTS_STYLE_ID}">${css}</style>`;
  return injectBeforeClosingTag(String(html || ''), style);
}

// Insere um trecho antes de </head>, com queda para </body> e, por fim, para o
// fim do documento.
//
// A busca de `</head>` é pela PRIMEIRA ocorrência e a de `</body>` pela ÚLTIMA,
// e a diferença importa: uma página que exiba código pode conter o texto
// "</head>" no corpo (num comentário, num <script type="text/template">), e a
// última ocorrência cairia lá dentro — o estilo entraria no meio do conteúdo,
// fora do head. Com `</body>` o risco é o inverso: o fechamento verdadeiro é o
// último, então é ele que vale.
export function injectBeforeClosingTag(html, snippet) {
  const lower = html.toLowerCase();
  const head = lower.indexOf('</head>');
  if (head !== -1) return html.slice(0, head) + snippet + html.slice(head);
  const body = lower.lastIndexOf('</body>');
  if (body !== -1) return html.slice(0, body) + snippet + html.slice(body);
  return html + snippet;
}
