// Base de conhecimento CURADA de modelos, famílias e fontes oficiais por
// provedor — a camada que faltava. As APIs dos provedores (GET /models)
// frequentemente devolvem só IDs "pelados", sem modalidades, capacidades,
// contexto ou preço. Este módulo:
//   1. registra, por provedor, os endpoints e as FONTES OFICIAIS a consultar
//      quando a API não basta (PROVIDER_SOURCES);
//   2. mantém defaults por FAMÍLIA (MODEL_FAMILIES) — um modelo novo de uma
//      família conhecida herda capacidades coerentes em vez de virar "só texto";
//   3. mantém dados curados por MODELO (CURATED_MODELS), verificados em fontes
//      oficiais, com procedência (source/verifiedAt/confidence);
//   4. faz o MERGE com os dados da API preservando o dado mais confiável e sem
//      sobrescrever informação boa com vazio;
//   5. deriva uma CLASSIFICAÇÃO (tier) coerente com as capacidades REAIS.
//
// A base fica em CÓDIGO (versionada, revisável em PR) de propósito — é
// conhecimento auditável. O histórico de mudanças AUTOMÁTICAS (pela rotina de
// sync) é que vai para o banco.

// ---------------------------------------------------------------------------
// 1. FONTES OFICIAIS POR PROVEDOR
// Registro interno de onde buscar informação de modelos. `modelsEndpoint` é o
// caminho REST relativo à baseURL; `officialDocs` são as páginas oficiais a
// consultar (pela rotina/curadoria) quando a API não traz tudo.
// ---------------------------------------------------------------------------
export const PROVIDER_SOURCES = Object.freeze({
  openrouter: {
    label: 'OpenRouter',
    modelsEndpoint: '/models',
    // O OpenRouter já entrega catálogo rico (modalidades, supported_parameters,
    // preço, contexto). É a fonte mais completa e serve de referência cruzada.
    officialDocs: ['https://openrouter.ai/models', 'https://openrouter.ai/docs/models'],
    richCatalog: true
  },
  deepseek: {
    label: 'DeepSeek',
    modelsEndpoint: '/models',
    officialDocs: ['https://api-docs.deepseek.com/quick_start/pricing', 'https://api-docs.deepseek.com/'],
    richCatalog: false
  },
  gemini: {
    label: 'Google Gemini',
    modelsEndpoint: '/models',
    officialDocs: ['https://ai.google.dev/gemini-api/docs/models', 'https://ai.google.dev/gemini-api/docs/pricing'],
    richCatalog: false
  },
  mistral: {
    label: 'Mistral AI',
    modelsEndpoint: '/models',
    officialDocs: ['https://docs.mistral.ai/getting-started/models/models_overview/', 'https://mistral.ai/pricing'],
    richCatalog: false
  },
  alibaba: {
    label: 'Alibaba Model Studio',
    modelsEndpoint: '/models',
    officialDocs: ['https://www.alibabacloud.com/help/en/model-studio/models', 'https://qwenlm.github.io/'],
    richCatalog: false
  },
  groq: {
    label: 'Groq',
    modelsEndpoint: '/models',
    officialDocs: ['https://console.groq.com/docs/models'],
    richCatalog: false
  },
  nvidia: {
    label: 'NVIDIA',
    modelsEndpoint: '/models',
    officialDocs: ['https://build.nvidia.com/models'],
    richCatalog: false
  },
  custom: { label: 'OpenAI compatível', modelsEndpoint: '/models', officialDocs: [], richCatalog: false }
});

export function providerSource(providerType) {
  const key = String(providerType || '').trim().toLowerCase();
  return PROVIDER_SOURCES[key] || PROVIDER_SOURCES.custom;
}

// ---------------------------------------------------------------------------
// Normalização de IDs/nomes para casar catálogo (API) com a base curada.
// ---------------------------------------------------------------------------
// Remove o prefixo de referência interna "<provider>::", o prefixo de vendor
// do OpenRouter "<vendor>/", o sufixo ":free"/":thinking" e datas.
export function bareModelId(id) {
  let s = String(id || '').trim();
  const sep = s.indexOf('::');
  if (sep >= 0) s = s.slice(sep + 2);          // referência interna
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);      // vendor/modelo do OpenRouter
  return s;
}

export function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // acentos
    .toLowerCase()
    .replace(/:free\b|:thinking\b|:nitro\b|:extended\b/g, '')
    .replace(/\b20\d{2}[-.]?\d{0,2}[-.]?\d{0,2}\b/g, '') // datas 2026 / 2026-07
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// 2. DEFAULTS POR FAMÍLIA
// Cada entrada casa por regex no ID puro (bareModelId) OU no nome. As
// capacidades aqui são o piso da família — um modelo sem entrada própria em
// CURATED_MODELS herda isto (com confiança 'family'), em vez de cair no
// "só texto" que a API pelada produz. Preenchido/expandido com dados das
// fontes oficiais (ver research). `tierHint` é a faixa típica da família.
// ---------------------------------------------------------------------------
// Capacidades multimodais comuns às famílias Gemini 2.5/3.x de texto (todas:
// visão, áudio e vídeo na ENTRADA, PDF, raciocínio nativo, ferramentas/function
// calling, grounding web e execução de código). NÃO geram imagem/áudio — isso
// é feito por modelos separados (Nano Banana / TTS). Fonte: ai.google.dev.
const GEMINI_LLM_CAPS = Object.freeze({
  text: true, tools: true, functionCalling: true, vision: true, reasoning: true,
  audio: true, video: true, files: true, web: true, code: true, image: false, embeddings: false
});
const GEMINI_LLM_FORMATS = Object.freeze(['text', 'image', 'audio', 'video', 'pdf']);

export const MODEL_FAMILIES = [
  // --- Google Gemini (texto/multimodal) ---
  // Casa qualquer gemini-2.5/3.x Pro/Flash de texto; EXCLUI variantes de mídia
  // (image/tts/live/embedding/computer-use), que têm entrada curada própria.
  {
    id: 'gemini-llm', label: 'Gemini', provider: 'Google',
    match: /^gemini-(?:2\.5|3(?:\.\d+)?)-(?:pro|flash)(?:-lite)?(?:-preview)?$/i,
    capabilities: GEMINI_LLM_CAPS, inputFormats: GEMINI_LLM_FORMATS, tierHint: 'A+',
    source: 'https://ai.google.dev/gemini-api/docs/models', confidence: 'family'
  },
  // --- Anthropic Claude --- todos os atuais: texto, visão, doc, raciocínio,
  // ferramentas, web, código. Sem áudio/vídeo/geração de imagem.
  {
    id: 'claude', label: 'Claude', provider: 'Anthropic',
    match: /^claude-(?:opus|sonnet|haiku|fable|mythos)/i,
    capabilities: { text: true, tools: true, functionCalling: true, vision: true, reasoning: true, web: true, code: true, files: true, audio: false, video: false, image: false, embeddings: false },
    inputFormats: ['text', 'image', 'pdf'], tierHint: 'S',
    source: 'https://platform.claude.com/docs/en/about-claude/models/overview', confidence: 'family'
  },
  // --- OpenAI GPT-5.x (chat) --- texto, visão, raciocínio, ferramentas, web,
  // código. Exclui as variantes de mídia (image/realtime/transcribe/tts).
  {
    id: 'gpt5', label: 'GPT-5', provider: 'OpenAI',
    match: /^gpt-5(?:\.\d+)?(?!.*(?:image|realtime|transcribe|audio|tts))/i,
    capabilities: { text: true, tools: true, functionCalling: true, vision: true, reasoning: true, web: true, code: true, files: true, audio: false, video: false, image: false, embeddings: false },
    inputFormats: ['text', 'image'], tierHint: 'S',
    source: 'https://developers.openai.com/api/docs/models', confidence: 'family'
  },
  // --- DeepSeek V4 --- texto, ferramentas, raciocínio, código (sem multimodal).
  {
    id: 'deepseek', label: 'DeepSeek', provider: 'DeepSeek',
    match: /^deepseek(?:-v4)?(?:-(?:pro|flash|chat|reasoner))?/i,
    capabilities: { text: true, tools: true, functionCalling: true, reasoning: true, code: true, vision: false, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A+',
    source: 'https://api-docs.deepseek.com/quick_start/pricing', confidence: 'family'
  },
  // --- GLM VISÃO (tem 'v' após a versão) --- vem ANTES do GLM chat para casar
  // primeiro (senão o chat capturaria e marcaria vision:false).
  {
    id: 'glm-vision', label: 'GLM Vision', provider: 'Z.AI',
    match: /^glm-[\d.]+v/i,
    capabilities: { text: true, tools: true, functionCalling: true, vision: true, reasoning: true, video: true, code: true, files: true, audio: false, image: false, web: false, embeddings: false },
    inputFormats: ['text', 'image', 'video'], tierHint: 'A+',
    source: 'https://docs.z.ai/guides/vlm/glm-4.5v', confidence: 'family'
  },
  // --- GLM chat --- texto, ferramentas, raciocínio, código.
  {
    id: 'glm', label: 'GLM', provider: 'Z.AI',
    match: /^glm-[\d.]/i,
    capabilities: { text: true, tools: true, functionCalling: true, reasoning: true, code: true, vision: false, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A+',
    source: 'https://docs.z.ai/guides/overview/pricing', confidence: 'family'
  },
  // --- xAI Grok 4.x --- texto, visão, raciocínio, ferramentas, web, código.
  {
    id: 'grok', label: 'Grok', provider: 'xAI',
    match: /^grok-4/i,
    capabilities: { text: true, tools: true, functionCalling: true, vision: true, reasoning: true, web: true, code: true, files: true, audio: false, video: false, image: false, embeddings: false },
    inputFormats: ['text', 'image'], tierHint: 'S',
    source: 'https://docs.x.ai/developers/models', confidence: 'family'
  },
  // --- Mistral --- piso seguro: texto, ferramentas, código. Visão e raciocínio
  // VARIAM por modelo (Large 3/Medium 3.5/Small 4/Ministral 3 têm visão;
  // Magistral raciocina) → ficam como `null` aqui e são fixados no curado.
  {
    id: 'mistral', label: 'Mistral', provider: 'Mistral',
    match: /^(?:mistral|ministral|magistral|devstral|codestral|pixtral)/i,
    capabilities: { text: true, tools: true, functionCalling: true, code: true, vision: null, reasoning: null, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A',
    source: 'https://docs.mistral.ai/models/overview', confidence: 'family'
  },
  // --- Qwen Omni (áudio+vídeo) e VL (visão) antes do Qwen chat ---
  {
    id: 'qwen-omni', label: 'Qwen Omni', provider: 'Alibaba',
    match: /^qwen[\d.]*-?omni/i,
    capabilities: { text: true, tools: true, functionCalling: true, vision: true, audio: true, video: true, files: true, reasoning: null, code: null, image: false, web: false, embeddings: false },
    inputFormats: ['text', 'image', 'audio', 'video'], tierHint: 'A',
    source: 'https://www.alibabacloud.com/help/en/model-studio/models', confidence: 'family'
  },
  {
    id: 'qwen-vl', label: 'Qwen VL', provider: 'Alibaba',
    match: /^qwen[\d.]*-?vl/i,
    capabilities: { text: true, tools: true, functionCalling: true, vision: true, video: true, files: true, reasoning: null, code: null, audio: false, image: false, web: false, embeddings: false },
    inputFormats: ['text', 'image', 'video'], tierHint: 'A',
    source: 'https://www.alibabacloud.com/help/en/model-studio/models', confidence: 'family'
  },
  {
    id: 'qwen', label: 'Qwen', provider: 'Alibaba',
    match: /^(?:qwen|qwq)/i,
    capabilities: { text: true, tools: true, functionCalling: true, reasoning: null, code: true, vision: false, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A',
    source: 'https://www.alibabacloud.com/help/en/model-studio/models', confidence: 'family'
  },
  // --- Moonshot Kimi --- texto, ferramentas, raciocínio, código; visão varia
  // por modelo (K2.5+/multimodal) → null aqui, fixada no curado.
  {
    id: 'kimi', label: 'Kimi', provider: 'Moonshot AI',
    match: /^kimi-/i,
    capabilities: { text: true, tools: true, functionCalling: true, reasoning: true, code: true, vision: null, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A+',
    source: 'https://platform.kimi.ai/docs/pricing/chat', confidence: 'family'
  },
  // --- MiniMax --- texto, ferramentas, raciocínio, código; visão/vídeo só no M3.
  {
    id: 'minimax', label: 'MiniMax', provider: 'MiniMax',
    match: /^minimax-/i,
    capabilities: { text: true, tools: true, functionCalling: true, reasoning: true, code: true, vision: null, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A+',
    source: 'https://platform.minimax.io/docs/release-notes/models', confidence: 'family'
  },
  // --- Meta Llama --- piso: texto, ferramentas, código; visão (Llama 4) e
  // raciocínio variam → null, fixados no curado.
  {
    id: 'llama', label: 'Llama', provider: 'Meta',
    match: /^llama-?[34]/i,
    capabilities: { text: true, tools: true, functionCalling: true, code: true, reasoning: null, vision: null, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A',
    source: 'https://www.llama.com/', confidence: 'family'
  },
  // --- NVIDIA Nemotron --- texto, ferramentas, raciocínio, código; a variante
  // Omni é multimodal (curado).
  {
    id: 'nemotron', label: 'Nemotron', provider: 'NVIDIA',
    match: /^nemotron/i,
    capabilities: { text: true, tools: true, functionCalling: true, reasoning: true, code: true, vision: null, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A+',
    source: 'https://build.nvidia.com/models', confidence: 'family'
  },
  // --- Google Gemma (open) --- Gemma 4 é multimodal; piso: texto, ferramentas,
  // código; visão/raciocínio no curado.
  {
    id: 'gemma', label: 'Gemma', provider: 'Google',
    match: /^gemma-?\d/i,
    capabilities: { text: true, tools: true, functionCalling: true, code: true, vision: null, reasoning: null, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'B+',
    source: 'https://ai.google.dev/gemma/docs/releases', confidence: 'family'
  },
  // --- Cohere Command --- texto, ferramentas, pesquisa web (connectors), código.
  {
    id: 'command', label: 'Command', provider: 'Cohere',
    match: /^command-/i,
    capabilities: { text: true, tools: true, functionCalling: true, web: true, code: true, vision: null, reasoning: null, audio: false, video: false, image: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A',
    source: 'https://docs.cohere.com/docs/models', confidence: 'family'
  },
  // --- Amazon Nova --- Lite/Pro/Premier: visão + vídeo + ferramentas; Micro texto.
  {
    id: 'nova', label: 'Nova', provider: 'Amazon',
    match: /nova-(?:micro|lite|pro|premier|2)/i,
    capabilities: { text: true, tools: true, functionCalling: true, code: true, vision: null, video: null, reasoning: null, audio: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A',
    source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html', confidence: 'family'
  },
  // --- Perplexity Sonar --- pesquisa web NATIVA; sem visão/áudio/vídeo.
  {
    id: 'sonar', label: 'Sonar', provider: 'Perplexity',
    match: /^sonar\b/i,
    capabilities: { text: true, web: true, tools: null, code: null, vision: false, audio: false, video: false, image: false, reasoning: null, functionCalling: null, embeddings: false },
    inputFormats: ['text'], tierHint: 'A',
    source: 'https://docs.perplexity.ai/getting-started/pricing', confidence: 'family'
  },
  // --- Baidu ERNIE --- texto, ferramentas, raciocínio; VL/5.0 multimodal (curado).
  {
    id: 'ernie', label: 'ERNIE', provider: 'Baidu',
    match: /^(?:baidu\/)?ernie-/i,
    capabilities: { text: true, tools: true, functionCalling: true, reasoning: null, code: null, vision: null, audio: false, video: false, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A',
    source: 'https://cloud.baidu.com/', confidence: 'family'
  },
  // --- ByteDance Doubao (Seed) --- multimodal: texto, visão, ferramentas, raciocínio.
  {
    id: 'doubao', label: 'Doubao', provider: 'ByteDance',
    match: /^doubao-/i,
    capabilities: { text: true, tools: true, functionCalling: true, vision: true, reasoning: true, code: true, files: true, audio: false, video: null, image: false, web: false, embeddings: false },
    inputFormats: ['text', 'image'], tierHint: 'A',
    source: 'https://www.volcengine.com/docs/82379', confidence: 'family'
  },
  // --- Xiaomi MiMo --- texto, ferramentas, raciocínio, código; V2.5 omnimodal.
  {
    id: 'mimo', label: 'MiMo', provider: 'Xiaomi',
    match: /^mimo-/i,
    capabilities: { text: true, tools: true, functionCalling: true, reasoning: true, code: true, vision: null, audio: null, video: null, image: false, web: false, embeddings: false },
    inputFormats: ['text'], tierHint: 'A+',
    source: 'https://huggingface.co/XiaomiMiMo', confidence: 'family'
  }
];

// ---------------------------------------------------------------------------
// 3. CONHECIMENTO CURADO POR MODELO
// Verificado em fontes oficiais. `match` casa por regex no ID puro ou no nome
// normalizado. Campos ausentes caem para o default de família e depois para a
// API. Procedência obrigatória: source (URL), verifiedAt (YYYY-MM-DD),
// confidence ('high'|'medium'|'low').
// ---------------------------------------------------------------------------
// Preços em USD por 1 MILHÃO de tokens (inUsd1M/outUsd1M) — convertidos para
// USD/token no merge. context/maxOutput em tokens. `capabilities` traz só o que
// difere do piso de família (ou o que precisa ser explícito). Verificado em
// 2026-07-22 nas fontes oficiais de cada provedor.
const V = '2026-07-22';
export const CURATED_MODELS = [
  // ---------------- Google Gemini ----------------
  { match: /^gemini-3\.1-pro/i, apiId: 'gemini-3.1-pro-preview', commercialName: 'Gemini 3.1 Pro', family: 'Gemini 3', tierHint: 'S+', context: 1048576, maxOutput: 65536, inUsd1M: 2, outUsd1M: 12, status: 'preview', source: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview', verifiedAt: V, confidence: 'high' },
  { match: /^gemini-3\.6-flash/i, apiId: 'gemini-3.6-flash', commercialName: 'Gemini 3.6 Flash', family: 'Gemini 3', tierHint: 'S', context: 1048576, maxOutput: 65536, inUsd1M: 1.5, outUsd1M: 7.5, status: 'active', source: 'https://ai.google.dev/gemini-api/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^gemini-3\.5-flash-lite/i, apiId: 'gemini-3.5-flash-lite', commercialName: 'Gemini 3.5 Flash-Lite', family: 'Gemini 3', tierHint: 'A+', context: 1048576, maxOutput: 65536, inUsd1M: 0.3, outUsd1M: 2.5, status: 'active', source: 'https://ai.google.dev/gemini-api/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^gemini-3\.5-flash\b/i, apiId: 'gemini-3.5-flash', commercialName: 'Gemini 3.5 Flash', family: 'Gemini 3', tierHint: 'A+', context: 1048576, maxOutput: 65536, inUsd1M: 1.5, outUsd1M: 9, status: 'active', source: 'https://ai.google.dev/gemini-api/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^gemini-2\.5-pro/i, apiId: 'gemini-2.5-pro', commercialName: 'Gemini 2.5 Pro', family: 'Gemini 2.5', tierHint: 'S', context: 1048576, maxOutput: 65536, inUsd1M: 1.25, outUsd1M: 10, status: 'active', replacement: 'gemini-3.1-pro-preview', sunsetOn: '2026-10-16', source: 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro', verifiedAt: V, confidence: 'high' },
  { match: /^gemini-2\.5-flash-lite/i, apiId: 'gemini-2.5-flash-lite', commercialName: 'Gemini 2.5 Flash-Lite', family: 'Gemini 2.5', tierHint: 'A', context: 1048576, maxOutput: 65536, inUsd1M: 0.1, outUsd1M: 0.4, status: 'active', replacement: 'gemini-3.1-flash-lite', sunsetOn: '2026-10-16', source: 'https://ai.google.dev/gemini-api/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^gemini-2\.5-flash\b/i, apiId: 'gemini-2.5-flash', commercialName: 'Gemini 2.5 Flash', family: 'Gemini 2.5', tierHint: 'A+', context: 1048576, maxOutput: 65536, inUsd1M: 0.3, outUsd1M: 2.5, status: 'active', replacement: 'gemini-3.6-flash', sunsetOn: '2026-10-16', source: 'https://ai.google.dev/gemini-api/docs/models', verifiedAt: V, confidence: 'high' },
  // Gemini geração de imagem ("Nano Banana") — saída de imagem, não é chat.
  { match: /^gemini-3-pro-image/i, apiId: 'gemini-3-pro-image', commercialName: 'Nano Banana Pro', family: 'Gemini 3', tierHint: 'A', context: 131072, maxOutput: 32768, status: 'active', capabilities: { text: true, vision: true, image: true, tools: false, functionCalling: false, reasoning: false, audio: false, video: false, web: false, code: false, files: false }, inputFormats: ['text', 'image'], source: 'https://ai.google.dev/gemini-api/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^gemini-2\.0-flash/i, apiId: 'gemini-2.0-flash', commercialName: 'Gemini 2.0 Flash', family: 'Gemini 2.0', tierHint: 'B+', status: 'deprecated', replacement: 'gemini-3.6-flash', source: 'https://ai.google.dev/gemini-api/docs/deprecations', verifiedAt: V, confidence: 'high' },

  // ---------------- Anthropic Claude ----------------
  { match: /^claude-fable-5/i, apiId: 'claude-fable-5', commercialName: 'Claude Fable 5', family: 'Fable', tierHint: 'S+', context: 1000000, maxOutput: 128000, inUsd1M: 10, outUsd1M: 50, status: 'active', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  { match: /^claude-opus-4-8/i, apiId: 'claude-opus-4-8', commercialName: 'Claude Opus 4.8', family: 'Opus', tierHint: 'S+', context: 1000000, maxOutput: 128000, inUsd1M: 5, outUsd1M: 25, status: 'active', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  { match: /^claude-sonnet-5/i, apiId: 'claude-sonnet-5', commercialName: 'Claude Sonnet 5', family: 'Sonnet', tierHint: 'S', context: 1000000, maxOutput: 128000, inUsd1M: 3, outUsd1M: 15, status: 'active', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  { match: /^claude-haiku-4-5/i, apiId: 'claude-haiku-4-5', commercialName: 'Claude Haiku 4.5', family: 'Haiku', tierHint: 'A+', context: 200000, maxOutput: 64000, inUsd1M: 1, outUsd1M: 5, status: 'active', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  { match: /^claude-opus-4-1/i, apiId: 'claude-opus-4-1', commercialName: 'Claude Opus 4.1', family: 'Opus', tierHint: 'S', status: 'deprecated', replacement: 'claude-opus-4-8', sunsetOn: '2026-08-05', inUsd1M: 15, outUsd1M: 75, source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },

  // ---------------- OpenAI ----------------
  { match: /^gpt-5\.6(?:-sol)?$/i, apiId: 'gpt-5.6', commercialName: 'GPT-5.6 Sol', family: 'GPT-5.6', tierHint: 'S+', context: 1050000, maxOutput: 128000, inUsd1M: 5, outUsd1M: 30, status: 'active', source: 'https://developers.openai.com/api/docs/models/gpt-5.6', verifiedAt: V, confidence: 'high' },
  { match: /^gpt-5\.6-terra/i, apiId: 'gpt-5.6-terra', commercialName: 'GPT-5.6 Terra', family: 'GPT-5.6', tierHint: 'S', context: 1050000, maxOutput: 128000, inUsd1M: 2.5, outUsd1M: 15, status: 'active', source: 'https://developers.openai.com/api/docs/pricing', verifiedAt: V, confidence: 'high' },
  { match: /^gpt-5\.6-luna/i, apiId: 'gpt-5.6-luna', commercialName: 'GPT-5.6 Luna', family: 'GPT-5.6', tierHint: 'A+', context: 1050000, maxOutput: 128000, inUsd1M: 1, outUsd1M: 6, status: 'active', source: 'https://developers.openai.com/api/docs/pricing', verifiedAt: V, confidence: 'high' },
  { match: /^gpt-image-2/i, apiId: 'gpt-image-2', commercialName: 'GPT Image 2', family: 'Image', tierHint: 'A', status: 'active', capabilities: { text: true, vision: true, image: true, tools: false, functionCalling: false, reasoning: false, audio: false, video: false, web: false, code: false }, inputFormats: ['text', 'image'], source: 'https://developers.openai.com/api/docs/models/gpt-image-2', verifiedAt: V, confidence: 'high' },
  { match: /^gpt-4o(?:-2|$)/i, apiId: 'gpt-4o', commercialName: 'GPT-4o', family: 'GPT-4o', tierHint: 'A', status: 'legacy', replacement: 'gpt-5.6', source: 'https://developers.openai.com/api/docs/deprecations', verifiedAt: V, confidence: 'medium' },

  // ---------------- DeepSeek ----------------
  { match: /^deepseek-v4-pro/i, apiId: 'deepseek-v4-pro', commercialName: 'DeepSeek V4 Pro', family: 'DeepSeek V4', tierHint: 'S', context: 1000000, maxOutput: 384000, inUsd1M: 0.435, outUsd1M: 0.87, status: 'active', source: 'https://api-docs.deepseek.com/quick_start/pricing', verifiedAt: V, confidence: 'high' },
  { match: /^deepseek-v4-flash/i, apiId: 'deepseek-v4-flash', commercialName: 'DeepSeek V4 Flash', family: 'DeepSeek V4', tierHint: 'A+', context: 1000000, maxOutput: 384000, inUsd1M: 0.14, outUsd1M: 0.28, status: 'active', source: 'https://api-docs.deepseek.com/quick_start/pricing', verifiedAt: V, confidence: 'high' },
  { match: /^deepseek-(?:chat|reasoner)$/i, commercialName: 'DeepSeek (alias)', family: 'DeepSeek V4', tierHint: 'A+', context: 1000000, maxOutput: 384000, status: 'legacy', replacement: 'deepseek-v4-flash', sunsetOn: '2026-07-24', source: 'https://api-docs.deepseek.com/quick_start/pricing', verifiedAt: V, confidence: 'high' },

  // ---------------- Z.AI GLM ----------------
  { match: /^glm-5\.2/i, apiId: 'glm-5.2', commercialName: 'GLM-5.2', family: 'GLM-5', tierHint: 'S', context: 1000000, maxOutput: 128000, inUsd1M: 1.4, outUsd1M: 4.4, status: 'active', source: 'https://docs.z.ai/guides/llm/glm-5.2', verifiedAt: V, confidence: 'high' },
  { match: /^glm-4\.6\b/i, apiId: 'glm-4.6', commercialName: 'GLM-4.6', family: 'GLM-4.x', tierHint: 'A+', context: 200000, maxOutput: 128000, inUsd1M: 0.6, outUsd1M: 2.2, status: 'active', source: 'https://docs.z.ai/guides/llm/glm-4.6', verifiedAt: V, confidence: 'high' },
  { match: /^glm-4\.5v/i, apiId: 'glm-4.5v', commercialName: 'GLM-4.5V', family: 'GLM Vision', tierHint: 'A+', maxOutput: 16000, inUsd1M: 0.6, outUsd1M: 1.8, status: 'active', capabilities: { vision: true, video: true }, source: 'https://docs.z.ai/guides/vlm/glm-4.5v', verifiedAt: V, confidence: 'high' },

  // ---------------- Mistral (exceções de visão/raciocínio) ----------------
  { match: /^mistral-large/i, apiId: 'mistral-large-latest', commercialName: 'Mistral Large 3', family: 'Mistral Large', tierHint: 'A+', context: 256000, inUsd1M: 0.5, outUsd1M: 1.5, status: 'active', capabilities: { vision: true, reasoning: true, files: true }, inputFormats: ['text', 'image'], source: 'https://docs.mistral.ai/models/model-cards/mistral-large-3-25-12', verifiedAt: V, confidence: 'high' },
  { match: /^mistral-medium/i, apiId: 'mistral-medium-latest', commercialName: 'Mistral Medium 3.5', family: 'Mistral Medium', tierHint: 'A', context: 256000, inUsd1M: 1.5, outUsd1M: 7.5, status: 'active', capabilities: { vision: true, reasoning: true, files: true }, inputFormats: ['text', 'image'], source: 'https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04', verifiedAt: V, confidence: 'high' },
  { match: /^mistral-small/i, apiId: 'mistral-small-latest', commercialName: 'Mistral Small 4', family: 'Mistral Small', tierHint: 'B+', context: 256000, inUsd1M: 0.15, outUsd1M: 0.6, status: 'active', capabilities: { reasoning: true, files: true }, source: 'https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03', verifiedAt: V, confidence: 'high' },
  { match: /^codestral(?!-embed)/i, apiId: 'codestral-2508', commercialName: 'Codestral', family: 'Mistral Codestral', tierHint: 'A', context: 128000, inUsd1M: 0.3, outUsd1M: 0.9, status: 'active', capabilities: { vision: false, reasoning: false }, source: 'https://docs.mistral.ai/models/model-cards/codestral-25-08', verifiedAt: V, confidence: 'high' },
  { match: /^magistral-medium/i, apiId: 'magistral-medium-2509', commercialName: 'Magistral Medium 1.2', family: 'Magistral', tierHint: 'A', context: 128000, inUsd1M: 2, outUsd1M: 5, status: 'deprecated', replacement: 'mistral-medium-latest', sunsetOn: '2026-05-22', capabilities: { reasoning: true, vision: true }, source: 'https://docs.mistral.ai/models/model-cards/magistral-medium-1-2-25-09', verifiedAt: V, confidence: 'high' },
  { match: /^pixtral/i, commercialName: 'Pixtral', family: 'Pixtral', tierHint: 'B+', status: 'legacy', replacement: 'mistral-small-latest', capabilities: { vision: true }, inputFormats: ['text', 'image'], source: 'https://docs.mistral.ai/models/overview', verifiedAt: V, confidence: 'medium' },

  // ---------------- xAI Grok ----------------
  { match: /^grok-4\.5/i, apiId: 'grok-4.5', commercialName: 'Grok 4.5', family: 'Grok 4.5', tierHint: 'S', context: 500000, inUsd1M: 2, outUsd1M: 6, status: 'active', source: 'https://docs.x.ai/developers/grok-4-5', verifiedAt: V, confidence: 'high' },
  { match: /^grok-4\.3/i, apiId: 'grok-4.3', commercialName: 'Grok 4.3', family: 'Grok 4', tierHint: 'S', context: 1000000, inUsd1M: 1.25, outUsd1M: 2.5, status: 'active', source: 'https://docs.x.ai/developers/models', verifiedAt: V, confidence: 'high' },
  { match: /^grok-3\b/i, commercialName: 'Grok 3', family: 'Grok 3', tierHint: 'A', status: 'legacy', replacement: 'grok-4.3', capabilities: { vision: true, tools: true, reasoning: true, web: true, code: true }, source: 'https://docs.x.ai/developers/models', verifiedAt: V, confidence: 'medium' },

  // ---------------- Alibaba Qwen ----------------
  { match: /^qwen3\.7-max/i, apiId: 'qwen3.7-max', commercialName: 'Qwen3.7 Max', family: 'Qwen3 Max', tierHint: 'S', context: 1000000, inUsd1M: 2.5, outUsd1M: 7.5, status: 'active', capabilities: { reasoning: true }, source: 'https://www.alibabacloud.com/help/en/model-studio/models', verifiedAt: V, confidence: 'medium' },
  { match: /^qwen-turbo/i, commercialName: 'Qwen Turbo', family: 'Qwen', tierHint: 'B', status: 'legacy', source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', verifiedAt: V, confidence: 'medium' },

  // ============ VARIANTES ADICIONAIS (rodada 1) ============
  // -- Gemini --
  { match: /^gemini-3\.1-flash-lite/i, apiId: 'gemini-3.1-flash-lite', commercialName: 'Gemini 3.1 Flash-Lite', family: 'Gemini 3', tierHint: 'A', context: 1048576, maxOutput: 65536, inUsd1M: 0.25, outUsd1M: 1.5, status: 'active', source: 'https://ai.google.dev/gemini-api/docs/models', verifiedAt: V, confidence: 'high' },
  // -- Anthropic Claude (gerações anteriores, legado) --
  { match: /^claude-opus-4-7/i, apiId: 'claude-opus-4-7', commercialName: 'Claude Opus 4.7', family: 'Opus', tierHint: 'S+', context: 1000000, maxOutput: 128000, inUsd1M: 5, outUsd1M: 25, status: 'legacy', replacement: 'claude-opus-4-8', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  { match: /^claude-opus-4-6/i, apiId: 'claude-opus-4-6', commercialName: 'Claude Opus 4.6', family: 'Opus', tierHint: 'S', context: 1000000, maxOutput: 128000, inUsd1M: 5, outUsd1M: 25, status: 'legacy', replacement: 'claude-opus-4-8', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  { match: /^claude-sonnet-4-6/i, apiId: 'claude-sonnet-4-6', commercialName: 'Claude Sonnet 4.6', family: 'Sonnet', tierHint: 'A+', context: 1000000, maxOutput: 128000, inUsd1M: 3, outUsd1M: 15, status: 'legacy', replacement: 'claude-sonnet-5', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  { match: /^claude-sonnet-4-5/i, apiId: 'claude-sonnet-4-5', commercialName: 'Claude Sonnet 4.5', family: 'Sonnet', tierHint: 'A+', context: 200000, maxOutput: 64000, inUsd1M: 3, outUsd1M: 15, status: 'legacy', replacement: 'claude-sonnet-5', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  { match: /^claude-opus-4-5/i, apiId: 'claude-opus-4-5', commercialName: 'Claude Opus 4.5', family: 'Opus', tierHint: 'S', context: 200000, maxOutput: 64000, inUsd1M: 5, outUsd1M: 25, status: 'legacy', replacement: 'claude-opus-4-8', source: 'https://platform.claude.com/docs/en/about-claude/models/overview', verifiedAt: V, confidence: 'high' },
  // -- OpenAI (gerações anteriores) --
  { match: /^gpt-5\.5-pro/i, apiId: 'gpt-5.5-pro', commercialName: 'GPT-5.5 Pro', family: 'GPT-5.5', tierHint: 'S+', inUsd1M: 30, outUsd1M: 180, status: 'active', source: 'https://developers.openai.com/api/docs/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^gpt-5\.5(?!-pro)/i, apiId: 'gpt-5.5', commercialName: 'GPT-5.5', family: 'GPT-5.5', tierHint: 'S', inUsd1M: 5, outUsd1M: 30, status: 'active', replacement: 'gpt-5.6', source: 'https://developers.openai.com/api/docs/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^gpt-5\.4-mini/i, apiId: 'gpt-5.4-mini', commercialName: 'GPT-5.4 mini', family: 'GPT-5.4', tierHint: 'A+', inUsd1M: 0.75, outUsd1M: 4.5, status: 'active', source: 'https://developers.openai.com/api/docs/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^gpt-5\.4-nano/i, apiId: 'gpt-5.4-nano', commercialName: 'GPT-5.4 nano', family: 'GPT-5.4', tierHint: 'A', inUsd1M: 0.2, outUsd1M: 1.25, status: 'active', source: 'https://developers.openai.com/api/docs/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^gpt-5\.4(?!-(?:mini|nano|pro))/i, apiId: 'gpt-5.4', commercialName: 'GPT-5.4', family: 'GPT-5.4', tierHint: 'S', inUsd1M: 2.5, outUsd1M: 15, status: 'active', replacement: 'gpt-5.6-terra', source: 'https://developers.openai.com/api/docs/models/gpt-5.4', verifiedAt: V, confidence: 'medium' },
  { match: /^gpt-5\.3-codex/i, apiId: 'gpt-5.3-codex', commercialName: 'GPT-5.3 Codex', family: 'Codex', tierHint: 'A+', inUsd1M: 1.75, outUsd1M: 14, status: 'active', capabilities: { code: true, reasoning: true }, source: 'https://developers.openai.com/api/docs/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^gpt-5(?:-|$)/i, apiId: 'gpt-5', commercialName: 'GPT-5', family: 'GPT-5', tierHint: 'A+', context: 400000, inUsd1M: 1.25, outUsd1M: 10, status: 'legacy', replacement: 'gpt-5.6', source: 'https://developers.openai.com/api/docs/models/gpt-5', verifiedAt: V, confidence: 'medium' },
  { match: /^o3(?:-|$)/i, apiId: 'o3', commercialName: 'OpenAI o3', family: 'o-series', tierHint: 'A+', status: 'legacy', replacement: 'gpt-5.6', capabilities: { reasoning: true, vision: true, tools: true, code: true }, source: 'https://developers.openai.com/api/docs/deprecations', verifiedAt: V, confidence: 'medium' },
  { match: /^o4-mini/i, apiId: 'o4-mini', commercialName: 'OpenAI o4-mini', family: 'o-series', tierHint: 'A', status: 'legacy', replacement: 'gpt-5.6-luna', capabilities: { reasoning: true, vision: true, tools: true, code: true }, source: 'https://developers.openai.com/api/docs/deprecations', verifiedAt: V, confidence: 'medium' },
  { match: /^gpt-4\.1/i, apiId: 'gpt-4.1', commercialName: 'GPT-4.1', family: 'GPT-4.1', tierHint: 'A', status: 'legacy', replacement: 'gpt-5.6', capabilities: { vision: true, tools: true, code: true }, source: 'https://developers.openai.com/api/docs/deprecations', verifiedAt: V, confidence: 'medium' },
  // -- DeepSeek --
  { match: /^deepseek-r1/i, commercialName: 'DeepSeek R1', family: 'DeepSeek R1', tierHint: 'A', status: 'legacy', replacement: 'deepseek-v4-flash', capabilities: { reasoning: true, tools: false }, source: 'https://api-docs.deepseek.com/quick_start/pricing', verifiedAt: V, confidence: 'medium' },
  // -- Z.AI GLM (variantes) --
  { match: /^glm-5\.1/i, apiId: 'glm-5.1', commercialName: 'GLM-5.1', family: 'GLM-5', tierHint: 'S', inUsd1M: 1.4, outUsd1M: 4.4, status: 'active', source: 'https://docs.z.ai/guides/overview/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^glm-5(?:-|$)/i, apiId: 'glm-5', commercialName: 'GLM-5', family: 'GLM-5', tierHint: 'A+', inUsd1M: 1, outUsd1M: 3.2, status: 'active', source: 'https://docs.z.ai/guides/overview/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^glm-4\.7-flash/i, apiId: 'glm-4.7-flash', commercialName: 'GLM-4.7-Flash', family: 'GLM-4.x', tierHint: 'A', inUsd1M: 0, outUsd1M: 0, status: 'active', source: 'https://docs.z.ai/guides/overview/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^glm-4\.7/i, apiId: 'glm-4.7', commercialName: 'GLM-4.7', family: 'GLM-4.x', tierHint: 'A+', inUsd1M: 0.6, outUsd1M: 2.2, status: 'active', source: 'https://docs.z.ai/guides/overview/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^glm-4\.5-air/i, apiId: 'glm-4.5-air', commercialName: 'GLM-4.5-Air', family: 'GLM-4.5', tierHint: 'A', context: 128000, maxOutput: 96000, inUsd1M: 0.2, outUsd1M: 1.1, status: 'active', source: 'https://docs.z.ai/guides/llm/glm-4.5', verifiedAt: V, confidence: 'high' },
  { match: /^glm-4\.5-flash/i, apiId: 'glm-4.5-flash', commercialName: 'GLM-4.5-Flash', family: 'GLM-4.5', tierHint: 'B+', context: 128000, maxOutput: 96000, inUsd1M: 0, outUsd1M: 0, status: 'active', source: 'https://docs.z.ai/guides/overview/pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^glm-4\.5(?!v|-air|-flash)/i, apiId: 'glm-4.5', commercialName: 'GLM-4.5', family: 'GLM-4.5', tierHint: 'A+', context: 128000, maxOutput: 96000, inUsd1M: 0.6, outUsd1M: 2.2, status: 'active', source: 'https://docs.z.ai/guides/llm/glm-4.5', verifiedAt: V, confidence: 'high' },
  // -- Mistral (variantes) --
  { match: /^ministral-3/i, commercialName: 'Ministral 3', family: 'Ministral 3', tierHint: 'B+', inUsd1M: 0.15, outUsd1M: 0.15, status: 'active', capabilities: { vision: true, reasoning: true }, inputFormats: ['text', 'image'], source: 'https://mistral.ai/news/mistral-3', verifiedAt: V, confidence: 'medium' },
  { match: /^devstral-small/i, apiId: 'devstral-small-2512', commercialName: 'Devstral Small 2', family: 'Devstral', tierHint: 'B+', context: 256000, inUsd1M: 0.1, outUsd1M: 0.3, status: 'active', capabilities: { code: true, vision: false, reasoning: false }, source: 'https://docs.mistral.ai/models/model-cards/devstral-small-2-25-12', verifiedAt: V, confidence: 'high' },
  { match: /^devstral/i, apiId: 'devstral-2512', commercialName: 'Devstral 2', family: 'Devstral', tierHint: 'A', context: 256000, inUsd1M: 0.4, outUsd1M: 2, status: 'active', capabilities: { code: true, reasoning: true, vision: false }, source: 'https://docs.mistral.ai/models/model-cards/devstral-2-25-12', verifiedAt: V, confidence: 'high' },
  { match: /^magistral-small/i, apiId: 'magistral-small-2509', commercialName: 'Magistral Small 1.2', family: 'Magistral', tierHint: 'B+', context: 128000, inUsd1M: 0.5, outUsd1M: 1.5, status: 'active', capabilities: { reasoning: true, vision: false }, source: 'https://mistral.ai/news/magistral', verifiedAt: V, confidence: 'medium' },
  // -- xAI Grok --
  { match: /^grok-4\.20/i, apiId: 'grok-4.20', commercialName: 'Grok 4.20', family: 'Grok 4.20', tierHint: 'S', context: 1000000, inUsd1M: 1.25, outUsd1M: 2.5, status: 'active', source: 'https://docs.x.ai/developers/models', verifiedAt: V, confidence: 'medium' },
  // -- Alibaba Qwen (variantes) --
  { match: /^qwen3\.7-plus/i, apiId: 'qwen3.7-plus', commercialName: 'Qwen3.7 Plus', family: 'Qwen3 Plus', tierHint: 'A+', status: 'active', capabilities: { vision: true, video: true, reasoning: true }, inputFormats: ['text', 'image', 'video'], source: 'https://www.alibabacloud.com/help/en/model-studio/models', verifiedAt: V, confidence: 'medium' },
  { match: /^qwen(?:3(?:\.\d)?)?-?coder/i, commercialName: 'Qwen Coder', family: 'Qwen Coder', tierHint: 'A', context: 1000000, status: 'active', capabilities: { code: true, reasoning: null }, source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', verifiedAt: V, confidence: 'medium' },
  { match: /^qwq/i, commercialName: 'QwQ', family: 'QwQ', tierHint: 'A', inUsd1M: 0.8, outUsd1M: 2.4, status: 'active', capabilities: { reasoning: true }, source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', verifiedAt: V, confidence: 'medium' },

  // ============ FAMÍLIAS NOVAS (rodada 2) ============
  // -- Moonshot Kimi --
  { match: /^kimi-k3/i, apiId: 'kimi-k3', commercialName: 'Kimi K3', family: 'Kimi K3', tierHint: 'S', context: 1048576, inUsd1M: 3, outUsd1M: 15, status: 'active', capabilities: { reasoning: true, tools: true, code: true }, source: 'https://platform.kimi.ai/docs/pricing/chat-k3', verifiedAt: V, confidence: 'high' },
  { match: /^kimi-k2\.7/i, apiId: 'kimi-k2.7-code', commercialName: 'Kimi K2.7 Code', family: 'Kimi K2.7', tierHint: 'A+', context: 262144, inUsd1M: 0.95, outUsd1M: 4, status: 'active', capabilities: { vision: true, reasoning: true, code: true }, inputFormats: ['text', 'image'], source: 'https://platform.kimi.ai/docs/pricing/chat-k27-code', verifiedAt: V, confidence: 'high' },
  { match: /^kimi-k2\.6/i, apiId: 'kimi-k2.6', commercialName: 'Kimi K2.6', family: 'Kimi K2.6', tierHint: 'A+', context: 262144, inUsd1M: 0.95, outUsd1M: 4, status: 'active', capabilities: { vision: true, reasoning: true, code: true }, inputFormats: ['text', 'image'], source: 'https://platform.kimi.ai/docs/pricing/chat-k26', verifiedAt: V, confidence: 'high' },
  { match: /^kimi-k2\.5/i, apiId: 'kimi-k2.5', commercialName: 'Kimi K2.5', family: 'Kimi K2.5', tierHint: 'A+', context: 262144, inUsd1M: 0.6, outUsd1M: 3, status: 'active', capabilities: { vision: true, video: true, reasoning: true, code: true }, inputFormats: ['text', 'image', 'video'], source: 'https://platform.kimi.ai/docs/pricing/chat-k25', verifiedAt: V, confidence: 'high' },
  { match: /^moonshot-v1/i, commercialName: 'Moonshot V1', family: 'moonshot-v1', tierHint: 'B', status: 'legacy', replacement: 'kimi-k2.6', capabilities: { reasoning: false }, source: 'https://platform.kimi.ai/docs/pricing/chat-v1', verifiedAt: V, confidence: 'high' },
  // -- MiniMax --
  { match: /^minimax-m3/i, apiId: 'MiniMax-M3', commercialName: 'MiniMax-M3', family: 'MiniMax M3', tierHint: 'S', context: 1000000, inUsd1M: 0.3, outUsd1M: 1.2, status: 'active', capabilities: { vision: true, video: true, reasoning: true }, inputFormats: ['text', 'image', 'video'], source: 'https://www.minimax.io/models/text/m3', verifiedAt: V, confidence: 'high' },
  { match: /^minimax-m2/i, commercialName: 'MiniMax-M2', family: 'MiniMax M2', tierHint: 'A+', context: 204800, inUsd1M: 0.3, outUsd1M: 1.2, status: 'active', capabilities: { reasoning: true, vision: false }, source: 'https://platform.minimax.io/docs/release-notes/models', verifiedAt: V, confidence: 'medium' },
  // -- Meta Llama (open-weight: preço fica com a API) --
  { match: /^llama-4-scout/i, apiId: 'llama-4-scout', commercialName: 'Llama 4 Scout', family: 'Llama 4', tierHint: 'A', context: 1000000, status: 'active', capabilities: { vision: true, reasoning: true, code: true }, inputFormats: ['text', 'image'], source: 'https://ai.meta.com/blog/llama-4-multimodal-intelligence/', verifiedAt: V, confidence: 'medium' },
  { match: /^llama-4-maverick/i, apiId: 'llama-4-maverick', commercialName: 'Llama 4 Maverick', family: 'Llama 4', tierHint: 'A+', context: 1000000, status: 'active', capabilities: { vision: true, reasoning: true, code: true }, inputFormats: ['text', 'image'], source: 'https://ai.meta.com/blog/llama-4-multimodal-intelligence/', verifiedAt: V, confidence: 'medium' },
  { match: /^llama-3\.3-70b/i, apiId: 'llama-3.3-70b-instruct', commercialName: 'Llama 3.3 70B', family: 'Llama 3.x', tierHint: 'A', context: 131072, status: 'active', capabilities: { vision: false, code: true }, source: 'https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct', verifiedAt: V, confidence: 'medium' },
  // -- NVIDIA Nemotron (open-weight) --
  { match: /nemotron-3-ultra/i, commercialName: 'Nemotron 3 Ultra', family: 'Nemotron 3', tierHint: 'A+', context: 512000, status: 'active', capabilities: { reasoning: true }, source: 'https://build.nvidia.com/models', verifiedAt: V, confidence: 'medium' },
  { match: /nemotron-3-super/i, commercialName: 'Nemotron 3 Super', family: 'Nemotron 3', tierHint: 'A+', context: 1000000, status: 'active', capabilities: { reasoning: true }, source: 'https://build.nvidia.com/models', verifiedAt: V, confidence: 'medium' },
  { match: /nemotron-3-nano-omni/i, commercialName: 'Nemotron 3 Nano Omni', family: 'Nemotron 3', tierHint: 'A', context: 262144, status: 'active', capabilities: { vision: true, audio: true, video: true, reasoning: true }, inputFormats: ['text', 'image', 'audio', 'video'], source: 'https://developer.nvidia.com/blog/nvidia-nemotron-3-nano-omni-powers-multimodal-agent-reasoning-in-a-single-efficient-open-model/', verifiedAt: V, confidence: 'medium' },
  { match: /nemotron-3-nano/i, commercialName: 'Nemotron 3 Nano', family: 'Nemotron 3', tierHint: 'A', context: 262144, status: 'active', capabilities: { reasoning: true, vision: false }, source: 'https://build.nvidia.com/models', verifiedAt: V, confidence: 'medium' },
  // -- Google Gemma (open-weight) --
  { match: /^gemma-4-e\d/i, commercialName: 'Gemma 4 (edge)', family: 'Gemma 4', tierHint: 'B+', context: 128000, status: 'active', capabilities: { vision: true, audio: true, reasoning: true }, inputFormats: ['text', 'image', 'audio'], source: 'https://ai.google.dev/gemma/docs/core/model_card_4', verifiedAt: V, confidence: 'high' },
  { match: /^gemma-4/i, commercialName: 'Gemma 4', family: 'Gemma 4', tierHint: 'A', context: 256000, status: 'active', capabilities: { vision: true, reasoning: true }, inputFormats: ['text', 'image', 'video'], source: 'https://ai.google.dev/gemma/docs/core/model_card_4', verifiedAt: V, confidence: 'high' },
  { match: /^gemma-3n/i, commercialName: 'Gemma 3n', family: 'Gemma 3n', tierHint: 'B', context: 32000, status: 'active', capabilities: { vision: true, audio: true, reasoning: false }, inputFormats: ['text', 'image', 'audio'], source: 'https://ai.google.dev/gemma/docs/releases', verifiedAt: V, confidence: 'high' },
  { match: /^gemma-3-(?:1b|270m)/i, commercialName: 'Gemma 3 (small)', family: 'Gemma 3', tierHint: 'C', context: 32000, status: 'active', capabilities: { vision: false, reasoning: false }, source: 'https://ai.google.dev/gemma/docs/core/model_card_3', verifiedAt: V, confidence: 'high' },
  { match: /^gemma-3/i, commercialName: 'Gemma 3', family: 'Gemma 3', tierHint: 'B+', context: 128000, status: 'active', capabilities: { vision: true, reasoning: false }, inputFormats: ['text', 'image'], source: 'https://ai.google.dev/gemma/docs/core/model_card_3', verifiedAt: V, confidence: 'high' },
  // -- Cohere Command --
  { match: /^command-a-plus/i, apiId: 'command-a-plus-05-2026', commercialName: 'Command A+', family: 'Command A', tierHint: 'A+', context: 128000, maxOutput: 64000, status: 'active', capabilities: { vision: true, reasoning: true, web: true }, inputFormats: ['text', 'image'], source: 'https://docs.cohere.com/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^command-a-reasoning/i, apiId: 'command-a-reasoning-08-2025', commercialName: 'Command A Reasoning', family: 'Command A', tierHint: 'A', context: 256000, status: 'active', capabilities: { reasoning: true, web: true }, source: 'https://docs.cohere.com/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^command-a-vision/i, apiId: 'command-a-vision-07-2025', commercialName: 'Command A Vision', family: 'Command A', tierHint: 'A', status: 'active', capabilities: { vision: true, web: true }, inputFormats: ['text', 'image'], source: 'https://docs.cohere.com/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^command-a\b/i, apiId: 'command-a-03-2025', commercialName: 'Command A', family: 'Command A', tierHint: 'A', context: 256000, maxOutput: 8000, inUsd1M: 2.5, outUsd1M: 10, status: 'active', source: 'https://docs.cohere.com/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^command-r7b/i, apiId: 'command-r7b-12-2024', commercialName: 'Command R7B', family: 'Command R', tierHint: 'B', context: 128000, inUsd1M: 0.0375, outUsd1M: 0.15, status: 'active', source: 'https://docs.cohere.com/docs/models', verifiedAt: V, confidence: 'high' },
  { match: /^command-r-plus/i, apiId: 'command-r-plus-08-2024', commercialName: 'Command R+', family: 'Command R', tierHint: 'A', context: 128000, inUsd1M: 2.5, outUsd1M: 10, status: 'active', source: 'https://cohere.com/pricing', verifiedAt: V, confidence: 'high' },
  { match: /^command-r\b/i, apiId: 'command-r-08-2024', commercialName: 'Command R', family: 'Command R', tierHint: 'B+', context: 128000, inUsd1M: 0.15, outUsd1M: 0.6, status: 'active', source: 'https://docs.cohere.com/docs/models', verifiedAt: V, confidence: 'high' },
  // -- Amazon Nova --
  { match: /nova-2-lite/i, apiId: 'amazon.nova-2-lite-v1:0', commercialName: 'Amazon Nova 2 Lite', family: 'Nova 2', tierHint: 'A+', context: 1000000, maxOutput: 65536, status: 'active', capabilities: { vision: true, video: true, reasoning: true, web: true, files: true }, inputFormats: ['text', 'image', 'video'], source: 'https://docs.aws.amazon.com/nova/latest/nova2-userguide/what-is-nova-2.html', verifiedAt: V, confidence: 'high' },
  { match: /nova-premier/i, apiId: 'amazon.nova-premier-v1:0', commercialName: 'Amazon Nova Premier', family: 'Nova 1', tierHint: 'A+', context: 1000000, maxOutput: 10000, inUsd1M: 2.5, outUsd1M: 12.5, status: 'active', capabilities: { vision: true, video: true, files: true }, inputFormats: ['text', 'image', 'video'], source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html', verifiedAt: V, confidence: 'high' },
  { match: /nova-pro/i, apiId: 'amazon.nova-pro-v1:0', commercialName: 'Amazon Nova Pro', family: 'Nova 1', tierHint: 'A', context: 300000, maxOutput: 10000, inUsd1M: 0.8, outUsd1M: 3.2, status: 'active', capabilities: { vision: true, video: true, files: true }, inputFormats: ['text', 'image', 'video'], source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html', verifiedAt: V, confidence: 'high' },
  { match: /nova-lite/i, apiId: 'amazon.nova-lite-v1:0', commercialName: 'Amazon Nova Lite', family: 'Nova 1', tierHint: 'B+', context: 300000, maxOutput: 10000, inUsd1M: 0.06, outUsd1M: 0.24, status: 'active', capabilities: { vision: true, video: true, files: true }, inputFormats: ['text', 'image', 'video'], source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html', verifiedAt: V, confidence: 'high' },
  { match: /nova-micro/i, apiId: 'amazon.nova-micro-v1:0', commercialName: 'Amazon Nova Micro', family: 'Nova 1', tierHint: 'B', context: 128000, maxOutput: 10000, inUsd1M: 0.035, outUsd1M: 0.14, status: 'active', capabilities: { vision: false }, source: 'https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html', verifiedAt: V, confidence: 'high' },
  // -- Perplexity Sonar --
  { match: /^sonar-pro\b/i, apiId: 'sonar-pro', commercialName: 'Sonar Pro', family: 'Sonar', tierHint: 'A+', context: 200000, inUsd1M: 3, outUsd1M: 15, status: 'active', capabilities: { web: true }, source: 'https://docs.perplexity.ai/getting-started/pricing', verifiedAt: V, confidence: 'high' },
  { match: /^sonar-reasoning/i, apiId: 'sonar-reasoning-pro', commercialName: 'Sonar Reasoning Pro', family: 'Sonar', tierHint: 'A+', context: 128000, inUsd1M: 2, outUsd1M: 8, status: 'active', capabilities: { reasoning: true, web: true }, source: 'https://docs.perplexity.ai/getting-started/pricing', verifiedAt: V, confidence: 'high' },
  { match: /^sonar-deep-research/i, apiId: 'sonar-deep-research', commercialName: 'Sonar Deep Research', family: 'Sonar', tierHint: 'A+', context: 128000, inUsd1M: 2, outUsd1M: 8, status: 'active', capabilities: { reasoning: true, web: true }, source: 'https://docs.perplexity.ai/getting-started/pricing', verifiedAt: V, confidence: 'high' },
  { match: /^sonar\b/i, apiId: 'sonar', commercialName: 'Sonar', family: 'Sonar', tierHint: 'A', context: 128000, inUsd1M: 1, outUsd1M: 1, status: 'active', capabilities: { web: true }, source: 'https://docs.perplexity.ai/getting-started/pricing', verifiedAt: V, confidence: 'high' },
  // -- Baidu ERNIE --
  { match: /ernie-5\.1/i, apiId: 'ernie-5.1', commercialName: 'ERNIE 5.1', family: 'ERNIE 5.x', tierHint: 'S', context: 128000, maxOutput: 65536, inUsd1M: 0.59, outUsd1M: 2.65, status: 'active', capabilities: { reasoning: true, tools: true }, source: 'https://cloud.baidu.com/', verifiedAt: V, confidence: 'medium' },
  { match: /ernie-5\.0/i, apiId: 'ernie-5.0', commercialName: 'ERNIE 5.0', family: 'ERNIE 5.x', tierHint: 'S', context: 128000, inUsd1M: 0.89, outUsd1M: 3.54, status: 'active', capabilities: { vision: true, audio: true, video: true, reasoning: true }, inputFormats: ['text', 'image', 'audio', 'video'], source: 'https://cloud.baidu.com/', verifiedAt: V, confidence: 'medium' },
  { match: /ernie-4\.5-(?:turbo-)?vl|ernie-4\.5-vl/i, commercialName: 'ERNIE 4.5 VL', family: 'ERNIE 4.5', tierHint: 'A', status: 'active', capabilities: { vision: true }, inputFormats: ['text', 'image'], source: 'https://openrouter.ai/baidu', verifiedAt: V, confidence: 'medium' },
  { match: /ernie-4\.5/i, commercialName: 'ERNIE 4.5', family: 'ERNIE 4.5', tierHint: 'A', context: 131072, status: 'active', replacement: 'ernie-5.1', source: 'https://openrouter.ai/baidu', verifiedAt: V, confidence: 'medium' },
  // -- ByteDance Doubao --
  { match: /doubao-seed-2/i, commercialName: 'Doubao Seed 2.1 Pro', family: 'Doubao Seed 2.x', tierHint: 'A+', context: 256000, inUsd1M: 0.83, outUsd1M: 4.14, status: 'active', capabilities: { vision: true, reasoning: true }, inputFormats: ['text', 'image'], source: 'https://www.volcengine.com/docs/82379', verifiedAt: V, confidence: 'medium' },
  { match: /doubao-seed-1[-.]6/i, commercialName: 'Doubao Seed 1.6', family: 'Doubao Seed 1.6', tierHint: 'A', context: 256000, inUsd1M: 0.111, outUsd1M: 1.111, status: 'active', capabilities: { vision: true, video: true, reasoning: true }, inputFormats: ['text', 'image', 'video'], source: 'https://www.volcengine.com/docs/82379', verifiedAt: V, confidence: 'medium' },
  { match: /doubao-(?:pro|lite)/i, commercialName: 'Doubao 1.5', family: 'Doubao 1.5', tierHint: 'B', status: 'legacy', replacement: 'doubao-seed-2.1-pro', capabilities: { vision: false }, source: 'https://www.volcengine.com/docs/82379', verifiedAt: V, confidence: 'low' },
  // -- Xiaomi MiMo (open-weight) --
  { match: /mimo-v2\.5-pro/i, commercialName: 'MiMo V2.5 Pro', family: 'MiMo V2.5', tierHint: 'A+', context: 1048576, status: 'active', capabilities: { reasoning: true, tools: true, code: true, vision: false }, source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro', verifiedAt: V, confidence: 'high' },
  { match: /mimo-v2\.5-asr/i, commercialName: 'MiMo V2.5 ASR', family: 'MiMo V2.5', tierHint: 'B', status: 'active', capabilities: { audio: true, reasoning: false, tools: false, code: false }, inputFormats: ['audio'], source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2.5-ASR', verifiedAt: V, confidence: 'high' },
  { match: /mimo-v2\.5(?!-)/i, commercialName: 'MiMo V2.5', family: 'MiMo V2.5', tierHint: 'A+', context: 1048576, status: 'active', capabilities: { vision: true, audio: true, video: true, reasoning: true, code: true }, inputFormats: ['text', 'image', 'audio', 'video'], source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2.5', verifiedAt: V, confidence: 'high' },
  { match: /mimo-v2-flash/i, commercialName: 'MiMo V2 Flash', family: 'MiMo V2', tierHint: 'A', context: 256000, status: 'active', capabilities: { reasoning: true, vision: false }, source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2-Flash', verifiedAt: V, confidence: 'high' }
];

// Índice de busca (montado uma vez).
function compileEntry(entry) {
  return {
    ...entry,
    _re: entry.match instanceof RegExp ? entry.match : null,
    _apiId: entry.apiId ? normalizeKey(entry.apiId) : null,
    _name: entry.commercialName ? normalizeKey(entry.commercialName) : null
  };
}
const CURATED_INDEX = CURATED_MODELS.map(compileEntry);
const FAMILY_INDEX = MODEL_FAMILIES.map(compileEntry);

function matchIn(index, id, name) {
  const bare = bareModelId(id);
  const keyId = normalizeKey(bare);
  const keyName = normalizeKey(name);
  // 1) apiId exato (mais forte)
  for (const e of index) if (e._apiId && (e._apiId === keyId || e._apiId === keyName)) return e;
  // 2) nome comercial exato
  for (const e of index) if (e._name && keyName && e._name === keyName) return e;
  // 3) regex (id puro ou nome)
  for (const e of index) if (e._re && (e._re.test(bare) || e._re.test(id) || (name && e._re.test(name)))) return e;
  return null;
}

// Conhecimento curado (modelo primeiro, depois família) para um id/nome.
export function findModelKnowledge(id, name = '') {
  return matchIn(CURATED_INDEX, id, name) || null;
}
export function findFamilyKnowledge(id, name = '') {
  return matchIn(FAMILY_INDEX, id, name) || null;
}

// ---------------------------------------------------------------------------
// 4. MERGE com procedência
// Regra de ouro: NUNCA sobrescrever um valor conhecido (da API ou já curado)
// por vazio/desconhecido. Precedência de capacidade: valor booleano curado
// (high) > booleano da API > default de família > null. Para números
// (contexto, preço), a API tem prioridade quando presente e > 0; senão o
// curado. Devolve { capabilities, fields, provenance }.
// ---------------------------------------------------------------------------
// Mesmas 11 chaves canônicas de CAPABILITY_KEYS. function calling ≡ tools aqui
// (não duplicamos no objeto; o perfil expõe `functionCalling` como alias).
const CAP_KEYS = ['text', 'tools', 'vision', 'image', 'reasoning', 'video', 'audio', 'web', 'files', 'code', 'embeddings'];

function pickBool(...vals) {
  for (const v of vals) if (v === true || v === false) return v;
  return null;
}
function pickNum(...vals) {
  for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
  return null;
}

// apiCaps: capacidades já derivadas da API (podem ter null onde a API calou).
// Mescla com o modelo curado e a família. Curado 'high' vence a API só quando
// a API está desconhecida (null) OU quando o curado é explicitamente
// verificado — a API nunca "rebaixa" um recurso que a fonte oficial confirma.
export function mergeCapabilities(apiCaps = {}, curated = null, family = null) {
  const out = {};
  const cur = curated?.capabilities || {};
  const fam = family?.capabilities || {};
  for (const k of CAP_KEYS) {
    const a = apiCaps[k];
    const c = cur[k];
    const f = fam[k];
    // Fonte oficial (curado) confirma um recurso => vale, mesmo se a API omitiu.
    if (c === true) { out[k] = true; continue; }
    // API afirma (true/false) => respeita a API.
    if (a === true || a === false) { out[k] = a; continue; }
    // Curado nega explicitamente.
    if (c === false) { out[k] = false; continue; }
    // Cai para o piso de família, senão desconhecido.
    out[k] = pickBool(f, null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. CLASSIFICAÇÃO (tier) coerente com as capacidades REAIS
// Combina: (a) uma faixa curada de qualidade quando conhecida (tierHint do
// modelo ou da família), e (b) um score derivado das capacidades/contexto,
// SEMPRE aplicando coerência: um modelo só-texto nunca alcança S/S+.
// Faixas: S+ > S > A+ > A > B+ > B > C.
// ---------------------------------------------------------------------------
const TIER_ORDER = ['C', 'B', 'B+', 'A', 'A+', 'S', 'S+'];
const TIER_RANK = Object.fromEntries(TIER_ORDER.map((t, i) => [t, i]));

function tierFromScore(score) {
  if (score >= 92) return 'S+';
  if (score >= 82) return 'S';
  if (score >= 70) return 'A+';
  if (score >= 55) return 'A';
  if (score >= 40) return 'B+';
  if (score >= 22) return 'B';
  return 'C';
}

// Teto de coerência: capacidades reais limitam a faixa máxima possível.
function coherenceCap(caps) {
  const multimodal = caps.vision === true || caps.audio === true || caps.video === true;
  if (caps.text === false && !caps.image && !caps.embeddings) return 'C';
  // "Profundidade": ferramentas, raciocínio OU pesquisa web nativa contam como
  // capacidade principal (um modelo Sonar vale pela web, não por ferramentas).
  const hasDepth = caps.tools === true || caps.reasoning === true || caps.web === true;
  // Só-texto raso (sem profundidade e sem multimodalidade): no máximo B+.
  if (!hasDepth && !multimodal) return 'B+';
  // Texto com profundidade mas sem multimodalidade: no máximo S.
  if (!multimodal) return 'S';
  return 'S+';
}

function capScore(caps, context = 0) {
  let s = 20;                                   // base para conversar em texto
  if (caps.tools === true) s += 16;
  if (caps.reasoning === true) s += 16;
  if (caps.vision === true) s += 12;
  if (caps.audio === true) s += 6;
  if (caps.video === true) s += 6;
  if (caps.image === true) s += 6;              // geração de imagem
  if (caps.web === true) s += 4;
  if (caps.code === true) s += 4;
  if (context >= 1_000_000) s += 10;
  else if (context >= 400_000) s += 8;
  else if (context >= 200_000) s += 6;
  else if (context >= 100_000) s += 4;
  else if (context >= 32_000) s += 2;
  return Math.min(100, s);
}

// A classificação: o tierHint (curadoria/família) é a AVALIAÇÃO de qualidade e
// tem prioridade — encapsula a análise de desempenho/geração que o mero score
// de capacidades não captura (um modelo pequeno multimodal não vira S só por
// marcar muitas caixas). Sem tierHint, cai no score derivado das capacidades.
// Em ambos os casos o TETO DE COERÊNCIA manda (só-texto raso nunca é S/S+).
export function classifyModel({ capabilities = {}, context = 0, tierHint = null } = {}) {
  const score = capScore(capabilities, context);
  let tier = (tierHint && TIER_RANK[tierHint] != null) ? tierHint : tierFromScore(score);
  const cap = coherenceCap(capabilities);
  if (TIER_RANK[tier] > TIER_RANK[cap]) tier = cap;   // coerência manda
  return { tier, rank: TIER_RANK[tier], score };
}

export const TIERS = TIER_ORDER;

// Conhecimento resolvido para um id/nome. O curado dá os campos específicos
// (tier, contexto, preço, status, nome); a família serve de PISO de capacidade
// (a entrada curada não repete as capacidades da família — herda). O merge
// garante que o curado, quando fala, vence a família.
export function knowledgeFor(id, name = '') {
  return { curated: findModelKnowledge(id, name), family: findFamilyKnowledge(id, name) };
}

// ---------------------------------------------------------------------------
// ENRIQUECIMENTO: junta o que a API trouxe com o conhecimento curado/família,
// preserva o dado mais confiável, deriva a classificação e devolve todos os
// campos extras com procedência. Números da API vencem quando presentes e > 0;
// senão entra o curado. Preços curados vêm em USD/1M e saem em USD/token.
// ---------------------------------------------------------------------------
export function enrichModelProfile({ id, name = '', apiCaps = {}, apiContext = 0, apiMaxOutput = 0, apiPriceIn = null, apiPriceOut = null, apiPricingKnown = false } = {}) {
  const { curated, family } = knowledgeFor(id, name);
  const know = curated || family || null;
  const capabilities = mergeCapabilities(apiCaps, curated, family);
  const tierHint = curated?.tierHint || family?.tierHint || null;
  const context = apiContext > 0 ? apiContext : (curated?.context || 0);
  const maxOutput = apiMaxOutput > 0 ? apiMaxOutput : (curated?.maxOutput || 0);
  const cls = classifyModel({ capabilities, context, tierHint });

  const apiHasPrice = apiPricingKnown && apiPriceIn != null;
  const priceIn = apiHasPrice ? Number(apiPriceIn)
    : (curated?.inUsd1M != null ? curated.inUsd1M / 1_000_000 : (apiPriceIn != null ? Number(apiPriceIn) : 0));
  const priceOut = apiHasPrice ? Number(apiPriceOut || 0)
    : (curated?.outUsd1M != null ? curated.outUsd1M / 1_000_000 : (apiPriceOut != null ? Number(apiPriceOut) : 0));
  const pricingKnown = apiHasPrice || curated?.inUsd1M != null;

  return {
    capabilities,
    tier: cls.tier, tierRank: cls.rank, tierScore: cls.score,
    commercialName: curated?.commercialName || null,
    knownFamily: curated?.family || family?.label || null,
    context, maxOutput, priceIn, priceOut, pricingKnown,
    status: know?.status || null,
    replacement: know?.replacement || null,
    sunsetOn: know?.sunsetOn || null,
    inputFormats: curated?.inputFormats || family?.inputFormats || null,
    streaming: true,               // todos os modelos de chat pesquisados fazem streaming
    source: know?.source || null,
    verifiedAt: know?.verifiedAt || null,
    confidence: know?.confidence || null,
    knowledgeSource: curated ? 'curated' : (family ? 'family' : 'provider_api')
  };
}
