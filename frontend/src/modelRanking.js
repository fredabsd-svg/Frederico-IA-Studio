// Classificação de referência dos modelos de IA, mantida manualmente (não vem
// de nenhuma API). Serve só para dar um contexto rápido de qualidade no
// seletor de modelo — não é a opinião de quem está logado, é uma curadoria do
// próprio app. Casa por NOME (não por id), já que o catálogo real vem do
// OpenRouter/DeepSeek em tempo real e usa nomes ligeiramente diferentes dos
// escritos aqui (ex.: variantes "Thinking"/"High" às vezes são o mesmo modelo
// no catálogo, outras vezes uma entrada própria) — por isso a normalização
// abaixo. Modelo que não bate com nada aqui simplesmente não ganha selo: é o
// comportamento seguro, nunca inventamos uma posição.

const TIER_BOUNDS = [
  { max: 10, tier: 'S+' },
  { max: 25, tier: 'S' },
  { max: 50, tier: 'A+' },
  { max: 75, tier: 'A' },
  { max: 90, tier: 'B+' },
  { max: 100, tier: 'B' }
];
const tierFor = rank => (TIER_BOUNDS.find(b => rank <= b.max) || TIER_BOUNDS[TIER_BOUNDS.length - 1]).tier;

// Nomes na ordem do ranking (posição no array = rank, 1-indexado).
const RANKED_NAMES = [
  'Claude Fable 5', 'GPT-5.6 Sol — xHigh', 'Kimi K3', 'Claude Opus 4.8 Thinking', 'GPT-5.5 High',
  'Grok 4.5', 'Claude Opus 4.7 Thinking', 'Claude Opus 4.6 Thinking', 'Gemini 3.1 Pro Preview', 'GLM-5.2 Max',
  'Claude Opus 4.8', 'GPT-5.5', 'Muse Spark 1.1', 'Gemini 3 Pro', 'Qwen 3.7 Max Preview',
  'Claude Opus 4.7', 'Claude Opus 4.6', 'Grok 4.20 Reasoning', 'GPT-5.4 High', 'DeepSeek V4 Pro Thinking',
  'GLM-5.1', 'Claude Sonnet 5 High', 'Gemini 3.6 Flash', 'Gemini 3.5 Flash High', 'GPT-5.2 Chat — 10/02/2026',
  'Grok 4.20 Multi-Agent', 'MiMo V2.5 Pro', 'Kimi K2.6', 'DeepSeek V4 Pro', 'GPT-5.4',
  'Qwen 3.5 Max Preview', 'Claude Sonnet 4.6', 'Muse Spark', 'Inkling', 'MiniMax M3',
  'ERNIE 5.1', 'Qwen 3.7 Plus', 'GLM-5', 'Grok 4.1 Thinking', 'GPT-5.5 Instant',
  'Gemini 3.5 Flash Medium', 'Grok 4.20 Beta 1', 'Claude Opus 4.5 Thinking', 'Qwen 3.6 Max Preview', 'Claude Opus 4.5',
  'Gemini 3 Flash', 'Claude Sonnet 4.5 Thinking', 'DeepSeek V4 Flash Thinking', 'Gemma 4 31B', 'DeepSeek V4 Flash',
  'NVIDIA Nemotron 3 Ultra 550B A55B', 'GPT-5.4 Mini High', 'MiMo V2 Pro', 'Kimi K2.5 Thinking', 'Gemini 3 Flash — Thinking Minimal',
  'Grok 4.1', 'Doubao Seed 2.0 Pro', 'Claude Sonnet 4.5', 'GPT-5.2 High', 'Gemini 3.5 Flash Lite',
  'GPT-5.3 Chat', 'Qwen 3.6 Plus', 'GLM-5V Turbo', 'Gemini 2.5 Pro', 'MiMo V2.5',
  'Qwen 3.5 397B A17B', 'Grok 4.3', 'GPT-5.1 High', 'ERNIE 5.0 Preview 1203', 'Gemma 4 26B A4B',
  'OpenAI o3', 'Kimi K2.5 Instant', 'LongCat Flash Chat 2602 Experimental', 'GLM-4.7', 'MiMo V2 Omni',
  'Grok 4.1 Fast Reasoning', 'Qwen 3 Max Preview', 'GPT-5.2', 'GPT-5 High', 'Kimi K2 Thinking Turbo',
  'Mistral Medium 3.5', 'ERNIE 5.0 0110', 'Claude Opus 4.1 Thinking', 'GPT-5.1', 'Gemini 3.1 Flash Lite Preview',
  'DeepSeek V3.2 Thinking', 'DeepSeek V3.2 Experimental Thinking', 'Qwen 3 235B A22B Instruct', 'GPT-5 Chat', 'GLM-4.6',
  'Claude Opus 4 Thinking', 'GPT-4.5 Preview', 'Claude Opus 4.1', 'DeepSeek V3.2', 'DeepSeek V3.2 Experimental',
  'Amazon Nova Experimental Chat 26-02-10', 'ChatGPT-4o — 26/03/2025', 'Qwen 3 Max — 23/09/2025', 'DeepSeek R1 0528', 'Grok 4 Fast Chat'
];

export const MODEL_RANKING = RANKED_NAMES.map((name, i) => ({ rank: i + 1, name, tier: tierFor(i + 1) }));

export const TIER_LABEL = { 'S+': 'S+', S: 'S', 'A+': 'A+', A: 'A', 'B+': 'B+', B: 'B' };
// Classe CSS não aceita "+" sem escape — vira sufixo "p" (Sp, Ap, Bp).
export const tierClass = tier => `tier${tier.replace('+', 'p')}`;

// Remove ruído comum de nomes de variante (esforço/data/rótulo de prévia) para
// permitir casar "Claude Opus 4.8" (nome no catálogo) com "Claude Opus 4.8
// Thinking" (nome na lista) quando não existe uma entrada exata para a base.
const NOISE_RE = /\b(preview|experimental|instant|thinking|reasoning|minimal|xhigh|high|medium|low|max|turbo|chat|beta ?\d*|multi-agent)\b/gi;
const DATE_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{2}/g;

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/\s+-\s+/g, ' ') // travessão usado como separador ("Sol — xHigh") vira espaço; hífen
                               // colado numa palavra ("gpt-5.6", "x-ai") não é tocado
    .replace(DATE_RE, '')
    .replace(/[.,:()]/g, '')  // remove pontuação sem quebrar números de versão ("5.6" -> "56")
    .replace(/\s+/g, ' ')
    .trim();
}
function baseOf(normalized) {
  return normalized.replace(NOISE_RE, '').replace(/\s+/g, ' ').trim();
}

const byExact = new Map();
const byBase = new Map();
for (const entry of MODEL_RANKING) {
  const exact = normalize(entry.name);
  if (!byExact.has(exact)) byExact.set(exact, entry);
  const base = baseOf(exact);
  if (base && !byBase.has(base)) byBase.set(base, entry);
}

// Devolve a entrada do ranking para um modelo do catálogo real, ou null se
// nada bater — nunca "chuta" uma posição aproximada.
export function findRanking(model) {
  const label = model?.name || model?.id || '';
  const exact = normalize(label);
  if (byExact.has(exact)) return byExact.get(exact);
  const base = baseOf(exact);
  if (base && byBase.has(base)) return byBase.get(base);
  return null;
}
