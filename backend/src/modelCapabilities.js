// A single source of truth for what a model can do in Frederico.
// `null` means that the provider did not publish enough information. It is
// intentionally different from `false`: unknown models can still be tried,
// while known-incompatible models never receive an unsupported parameter.
import { enrichModelProfile } from './modelKnowledge.js';

export const CAPABILITY_KEYS = Object.freeze(['text', 'tools', 'vision', 'image', 'reasoning', 'video', 'audio', 'web', 'files', 'code', 'embeddings']);

const catalog = new Map();

const TOOL_ACTION_RE = /\b(?:gere|crie|monte|produza|faca|construa|elabore|prepare|preencha|transforme|consolide|execute|rode|leia|analise|edite|salve|exporte|converta|extraia|compacte|baixe|pesquise|busque|consulte|abra|organize|transcreva|renderize|corrija|implemente|teste|verifique|instale|diagnostique|investigue)\b/i;
const TOOL_TARGET_RE = /\b(?:arquivo|planilha|excel|xlsx|word|docx|pdf|documento|relatorio|apresentacao|imagem|foto|video|svg|zip|anexo|upload|pasta|projeto|repositorio|workspace|site|pagina|url|internet|app|aplicativo|codigo|bug|erro|teste|ambiente|servidor|backend|frontend|cnpj|cnae|empresa)\b/i;
const OUTPUT_ACTION_RE = /\b(?:gere|crie|monte|produza|faca|construa|elabore|prepare|preencha|transforme|consolide|salve|exporte|converta|entregue|baixe)\b/i;
const OUTPUT_TARGET_RE = /\b(?:arquivo|planilha|excel|xlsx|word|docx|pdf|documento|relatorio|apresentacao|imagem|foto|video|svg|zip)\b/i;
const DIRECT_DELIVERY_RE = /\b(?:quero|preciso|gostaria(?:\s+de)?|me\s+(?:entregue|de))\b[\s\S]{0,48}\b(?:arquivo|planilha|excel|xlsx|word|docx|pdf|documento|imagem|foto|video|zip)\b/i;
const UPLOAD_REFERENCE_RE = /\b(?:anexo|anexado|arquivo|planilha|excel|xlsx|word|docx|pdf|documento|imagem|foto|video|isso|isto|este|esta|esse|essa)\b/i;

function normalizedText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function asStringList(value) {
  return Array.isArray(value) ? value.map(item => String(item).toLowerCase()) : null;
}

function capabilityValue(value, fallback) {
  return value === true ? true : value === false ? false : fallback;
}

// Faixa plausível de preço por TOKEN em USD: de 0 a 0.001 ($1.000 por 1M — os
// modelos de fronteira mais caros ficam em ~$180/1M). Fora disso é sentinela
// (-1 = "variável" no OpenRouter) ou unidade errada → null (não confirmado).
export function sanePricePerToken(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 0.001 ? n : null;
}

function declaredCapabilities(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    text: capabilityValue(value.text, true),
    tools: capabilityValue(value.tools, null),
    vision: capabilityValue(value.vision, false),
    image: capabilityValue(value.image, false),
    reasoning: capabilityValue(value.reasoning, null),
    video: capabilityValue(value.video, false),
    audio: capabilityValue(value.audio, null),
    web: capabilityValue(value.web, null),
    files: capabilityValue(value.files, null),
    code: capabilityValue(value.code, null),
    embeddings: capabilityValue(value.embeddings, null)
  };
}

function curatedOverrides(id) {
  // This model is known to be text-only. The fallback matters before the
  // catalog has loaded, for example right after a backend restart.
  if (/^ibm-granite\/granite-4\.0-h-micro(?::|$)/i.test(id)) {
    return { tools: false, reasoning: false };
  }
  return null;
}

function applyOverrides(capabilities, id) {
  const overrides = curatedOverrides(id);
  return overrides ? { ...capabilities, ...overrides } : capabilities;
}

export function deriveModelCapabilities(model = {}) {
  const declared = declaredCapabilities(model.capabilities);
  if (declared) return applyOverrides(declared, String(model.id || ''));

  const input = asStringList(model.architecture?.input_modalities) || [];
  const output = asStringList(model.architecture?.output_modalities) || [];
  const supportedParameters = asStringList(model.supported_parameters);
  const acceptsText = !input.length || input.includes('text');
  const returnsText = !output.length || output.includes('text');
  const hasReasoningParameter = supportedParameters?.some(parameter =>
    /(?:^|[_-])(?:reasoning|include_reasoning)(?:$|[_-])|reasoning_effort|reasoning_details/.test(parameter)
  );

  // Ferramentas: o OpenRouter lista "tools"; alguns provedores usam
  // "tool_choice" ou "functions" para o mesmo recurso.
  const hasToolsParameter = supportedParameters
    ? supportedParameters.some(p => p === 'tools' || p === 'tool_choice' || p === 'functions')
    : null;

  return applyOverrides({
    text: acceptsText && returnsText,
    tools: supportedParameters ? Boolean(hasToolsParameter) : null,
    // Visão = aceita imagem na ENTRADA (input_modalities). "image" abaixo é
    // GERAÇÃO de imagem (output_modalities) — coisas diferentes.
    vision: input.includes('image'),
    image: output.includes('image'),
    reasoning: supportedParameters ? Boolean(hasReasoningParameter) : null,
    video: input.includes('video') || output.includes('video'),
    audio: input.includes('audio') || output.includes('audio'),
    web: supportedParameters ? supportedParameters.some(p => p === 'web_search' || p === 'search') : null,
    files: supportedParameters ? supportedParameters.some(p => p === 'files' || p === 'file_ids') : null,
    code: supportedParameters ? supportedParameters.some(p => p === 'code_interpreter') : null,
    embeddings: model.type === 'embedding' || output.includes('embeddings')
  }, String(model.id || ''));
}

export function modelProfileFromProvider(model = {}) {
  const id = String(model.id || '');
  const apiCaps = deriveModelCapabilities(model);
  // Quando o provedor NÃO publicou modalidades (nem um objeto capabilities), o
  // `false` das capacidades de mídia é apenas o default — significa DESCONHECIDO,
  // não "não tem". Rebaixa para null para a base de conhecimento poder preencher
  // (senão um false-default bloquearia a visão real de, ex., Gemini/Claude).
  const publishedModalities = Array.isArray(model.architecture?.input_modalities) || Array.isArray(model.architecture?.output_modalities);
  if (!publishedModalities && !model.capabilities) {
    for (const k of ['vision', 'image', 'video', 'audio']) if (apiCaps[k] === false) apiCaps[k] = null;
  }
  const parameters = asStringList(model.supported_parameters);
  const pricing = model.pricing || {};
  // SANIDADE DE PREÇO (USD por TOKEN). Provedores mandam sentinelas e unidades
  // erradas: o OpenRouter devolve -1 no roteador automático ("preço variável",
  // que exibido virava "-$1.000.000/1M"), e um preço por-1M interpretado como
  // por-token multiplica por um milhão. Valor fora da faixa plausível NUNCA é
  // exibido: cai para o preço curado (documentação oficial) ou vira
  // "preço não confirmado".
  const rawPromptPrice = Number(pricing.prompt ?? model.price);
  const rawCompletionPrice = Number(pricing.completion);
  const negativeSentinel = rawPromptPrice < 0 || rawCompletionPrice < 0;
  const promptSane = sanePricePerToken(rawPromptPrice);
  const completionSane = sanePricePerToken(rawCompletionPrice);
  const apiPricingKnown = promptSane != null;
  const apiName = model.name || model.providerModelId || '';
  const apiContext = Number(model.context_length || model.top_provider?.context_length || model.context || 0);
  const apiMaxOutput = Number(model.max_output_tokens || model.max_completion_tokens || model.top_provider?.max_completion_tokens || 0);

  // Enriquecimento com a base de conhecimento curada (capacidades corrigidas,
  // classificação coerente, contexto/preço/formatos/status/substituto/fonte).
  const know = enrichModelProfile({
    id, name: apiName, apiCaps, apiContext, apiMaxOutput,
    apiPriceIn: promptSane,
    apiPriceOut: completionSane,
    apiPricingKnown
  });
  const capabilities = know.capabilities;
  // Sem preço validado (API sã ou curadoria), o valor é ZERO e pricingKnown
  // false — a interface mostra "preço não confirmado" em vez de números lixo.
  const price = know.pricingKnown ? know.priceIn : 0;
  const priceOut = know.pricingKnown ? know.priceOut : 0;

  return {
    id,
    // `id` pode ser a referência interna `<provider-id>::<model-id>`. Quando
    // o provedor não envia um nome amigável, usamos o nome comercial curado
    // (quando houver) e nunca vazamos a referência técnica para a interface.
    name: apiName || know.commercialName || id,
    providerId: model.providerId || null,
    providerName: model.providerName || '',
    providerType: model.providerType || '',
    providerModelId: model.providerModelId || id,
    family: know.knownFamily || model.family || String(model.providerModelId || id).split('/')[0].split('-')[0],
    capabilities,
    parameters,
    // Flat aliases keep older clients and saved UI state compatible.
    text: capabilities.text,
    tools: capabilities.tools,
    vision: capabilities.vision,
    image: capabilities.image,
    reasoning: capabilities.reasoning,
    video: capabilities.video,
    audio: capabilities.audio,
    web: capabilities.web,
    files: capabilities.files,
    code: capabilities.code,
    embeddings: capabilities.embeddings,
    functionCalling: capabilities.functionCalling ?? capabilities.tools,
    // --- Classificação coerente com as capacidades reais ---
    tier: know.tier,
    tierRank: know.tierRank,
    tierScore: know.tierScore,
    created: Number(model.created || 0),
    context: know.context || apiContext || 0,
    maxOutput: know.maxOutput || apiMaxOutput || 0,
    price: Number.isFinite(price) ? price : 0,
    priceOut: Number.isFinite(priceOut) ? priceOut : 0,
    pricingKnown: know.pricingKnown,
    // Preço "variável" (sentinela -1, ex.: roteador automático do OpenRouter):
    // só quando não há preço confiável de outra fonte para exibir.
    pricingVariable: negativeSentinel && !know.pricingKnown,
    // Procedência do PREÇO exibido: API do provedor ou documentação oficial
    // curada (com a data da verificação) — para a interface informar a origem.
    priceSource: know.pricingKnown ? (apiPricingKnown ? 'provider_api' : 'curated') : null,
    priceVerifiedAt: know.pricingKnown && !apiPricingKnown ? know.verifiedAt : null,
    // --- Campos novos do catálogo ---
    streaming: know.streaming,
    inputFormats: know.inputFormats,
    status: know.status || (model.active === false ? 'inactive' : null),
    replacement: know.replacement,
    sunsetOn: know.sunsetOn,
    active: typeof model.active === 'boolean' ? model.active : (know.status ? know.status === 'active' : null),
    speed: Number.isFinite(Number(model.speed)) ? Number(model.speed) : null,
    latency: Number.isFinite(Number(model.latency)) ? Number(model.latency) : null,
    // --- Procedência (fonte/data/confiança) ---
    metadataSource: know.knowledgeSource || model.metadata_source || 'provider_api',
    source: know.source,
    verifiedAt: know.verifiedAt,
    confidence: know.confidence,
    free: typeof model.free === 'boolean'
      ? model.free
      : id.endsWith(':free') || (know.pricingKnown && price === 0 && priceOut === 0)
  };
}

export function registerModelCatalog(models = [], owner = null) {
  const profiles = models.map(model => modelProfileFromProvider(owner ? {
    ...model,
    id: `${owner.providerId}::${model.id}`,
    providerId: owner.providerId,
    providerName: owner.providerName,
    providerType: owner.providerType,
    providerModelId: model.id
  } : model)).filter(model => model.id);
  for (const profile of profiles) catalog.set(profile.id, profile);
  return profiles;
}

export function getModelProfile(id) {
  const key = String(id || '');
  return catalog.get(key) || modelProfileFromProvider({ id: key, name: key });
}

export function unverifiedModelProfile(id, { name = null, free = false } = {}) {
  const profile = getModelProfile(id);
  return {
    ...profile,
    id: String(id || ''),
    name: name || profile.name || String(id || ''),
    free: Boolean(free || profile.free)
  };
}

export function supportsModelParameter(profile, parameter) {
  const parameters = profile?.parameters;
  if (!Array.isArray(parameters) && parameter === 'temperature' && /(?:^|\/)gpt-5\.6(?:-|$)/i.test(String(profile?.id || ''))) {
    return false;
  }
  return !Array.isArray(parameters) || parameters.includes(String(parameter || '').toLowerCase());
}

// Nome amigável do PROVEDOR/desenvolvedor do modelo, derivado do prefixo do id
// do OpenRouter (formato "provedor/modelo", ex.: "openai/gpt-4o" → "OpenAI").
// Usado na interface multimodelo para exibir de quem é cada resposta.
const PROVIDER_LABELS = {
  openai: 'OpenAI', 'anthropic': 'Anthropic', google: 'Google', 'meta-llama': 'Meta',
  mistralai: 'Mistral', deepseek: 'DeepSeek', qwen: 'Qwen', 'x-ai': 'xAI', cohere: 'Cohere',
  nvidia: 'NVIDIA', microsoft: 'Microsoft', perplexity: 'Perplexity', moonshotai: 'Moonshot AI',
  'z-ai': 'Z.AI', amazon: 'Amazon', openrouter: 'OpenRouter', nousresearch: 'Nous Research',
  minimax: 'MiniMax', bytedance: 'ByteDance', 'thudm': 'THUDM', ai21: 'AI21', inflection: 'Inflection',
  liquid: 'Liquid', 'inception': 'Inception', reka: 'Reka', gryphe: 'Gryphe', sao10k: 'Sao10K',
  poolside: 'Poolside', aionlabs: 'AionLabs'
};
export function providerLabel(id) {
  const prefix = String(id || '').split('/')[0].toLowerCase().trim();
  if (!prefix) return '';
  if (PROVIDER_LABELS[prefix]) return PROVIDER_LABELS[prefix];
  // Fallback: capitaliza o prefixo (ex.: "algum-provedor" → "Algum-provedor").
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export function markModelCapabilityUnsupported(id, capability) {
  if (!CAPABILITY_KEYS.includes(capability)) return null;
  const profile = getModelProfile(id);
  profile.capabilities[capability] = false;
  if (capability in profile) profile[capability] = false;
  catalog.set(profile.id, profile);
  return profile;
}

export function detectToolRequirement({ userText, webSearch = false, developer = false, hasUploads = false } = {}) {
  const reasons = [];
  const text = normalizedText(userText);
  const expectsOutput = (OUTPUT_ACTION_RE.test(text) && OUTPUT_TARGET_RE.test(text)) || DIRECT_DELIVERY_RE.test(text);
  if (webSearch) reasons.push('a pesquisa na internet ativada');
  if (developer) reasons.push('o modo desenvolvedor');
  if (hasUploads && UPLOAD_REFERENCE_RE.test(text)) reasons.push('a leitura dos arquivos anexados');
  if ((TOOL_ACTION_RE.test(text) && TOOL_TARGET_RE.test(text)) || DIRECT_DELIVERY_RE.test(text)) {
    reasons.push('a criação ou o processamento solicitado');
  }
  return { required: reasons.length > 0, reasons, expectsOutput };
}

export function buildModelCallPlan({ modelId, profile, tools = [], userText = '', webSearch = false, developer = false, hasUploads = false, reasoningEffort = null } = {}) {
  const resolvedProfile = profile || getModelProfile(modelId);
  const requestedTools = Array.isArray(tools) ? tools : [];
  const requirements = detectToolRequirement({ userText, webSearch, developer, hasUploads });
  const capabilities = resolvedProfile.capabilities;
  const toolsUnsupported = capabilities.tools === false;
  const textUnsupported = capabilities.text === false;

  return {
    profile: resolvedProfile,
    capabilities,
    requirements,
    tools: toolsUnsupported ? [] : requestedTools,
    reasoning: reasoningEffort && capabilities.reasoning === true ? reasoningEffort : null,
    degraded: {
      tools: toolsUnsupported && requestedTools.length > 0,
      reasoning: Boolean(reasoningEffort && capabilities.reasoning !== true)
    },
    blocked: textUnsupported
      ? { capability: 'text' }
      : (toolsUnsupported && requestedTools.length > 0 && requirements.required ? { capability: 'tools' } : null)
  };
}

// Estado recalculável de uma chamada. O loop usa a mesma função tanto no
// modelo inicial quanto em CADA failover; assim não carrega ferramentas,
// raciocínio ou parâmetros do modelo que acabou de falhar.
export function buildModelRuntimeState(input = {}) {
  const plan = buildModelCallPlan(input);
  const isGpt56Chat = /(?:^|\/)gpt-5\.6(?:-|$)/i.test(String(plan.profile?.id || input.modelId || ''));
  const reasoningEffort = isGpt56Chat && plan.tools.length ? 'none' : plan.reasoning;
  const reasoningParameter = isGpt56Chat
    || (supportsModelParameter(plan.profile, 'reasoning_effort') && !supportsModelParameter(plan.profile, 'reasoning'))
    ? 'reasoning_effort'
    : 'reasoning';
  return {
    plan,
    tools: plan.tools,
    reasoningEffort,
    reasoningParameter,
    acceptsTemperature: supportsModelParameter(plan.profile, 'temperature')
  };
}

export function modelCompatibilityMessage(plan) {
  const name = plan?.profile?.name || plan?.profile?.id || 'Este modelo';
  if (plan?.blocked?.capability === 'text') {
    return `O modelo **${name}** nao esta catalogado para conversa em texto. Escolha um modelo marcado como **Texto** para continuar esta conversa.`;
  }
  if (plan?.blocked?.capability === 'tools') {
    const reason = plan.requirements?.reasons?.[0] || 'esta tarefa';
    return `O modelo **${name}** conversa por texto, mas nao oferece **ferramentas** neste ambiente. Para ${reason}, escolha um modelo marcado com **Ferramentas** e envie este mesmo pedido novamente.`;
  }
  return `O modelo **${name}** nao oferece a capacidade necessaria para esta tarefa.`;
}

function errorText(error) {
  return [
    error?.message,
    error?.error?.message,
    error?.response?.data?.error?.message,
    error?.response?.data?.message
  ].filter(Boolean).join(' ');
}

export function isUnsupportedToolError(error) {
  return /support tool use|support tools|tool use is not supported|tools? (?:are|is) not supported|no endpoints found.*tool/i.test(errorText(error));
}

// Modelo indisponível no provedor: o ID não existe (foi renomeado/removido), não
// há endpoint que atenda o pedido, ou a conta não tem acesso a ele. O provedor
// responde 404 (às vezes 400 "not a valid model id"). Serve para acionar o
// FAILOVER de modelo (tentar a reserva) em vez de encerrar a tarefa de vez —
// exceto quando a causa é falta de ferramentas, que tem tratamento próprio.
export function isModelUnavailableError(error) {
  if (isUnsupportedToolError(error)) return false;
  const status = Number(error?.status ?? error?.response?.status ?? error?.error?.code ?? error?.code);
  const text = errorText(error);
  if (status === 404) return true;
  return /not a valid model|no (?:allowed )?(?:endpoints?|providers?)[\w\s]{0,20}(?:found|available)|model (?:not found|does not exist|is not available)|no such model/i.test(text);
}

export function isUnsupportedReasoningError(error) {
  return /reasoning(?: effort| parameter| controls?)?.*(?:not supported|unsupported)|(?:not supported|unsupported).*reasoning/i.test(errorText(error));
}

// Conflito tool_choice='required' × modo thinking: provedores como Qwen/GLM
// respondem 400 "The tool_choice parameter does not support being set to
// required or object in thinking mode". A chamada deve ser refeita com
// tool_choice='auto' (as ferramentas continuam disponíveis ao modelo).
export function isToolChoiceReasoningConflictError(error) {
  const text = errorText(error);
  return /tool_choice[^.]{0,80}(?:thinking|reasoning) mode|(?:thinking|reasoning) mode[^.]{0,80}tool_choice/i.test(text)
    || (/tool_choice/i.test(text) && /does not support|not supported|unsupported/i.test(text) && /thinking|reasoning/i.test(text));
}

// O modelo (ou o endpoint escolhido) não aceita imagem na entrada, apesar de
// ter sido tratado como capaz de visão. Nesse caso removemos as imagens e
// caímos para OCR.
export function isUnsupportedVisionError(error) {
  return /image(?:_url)?[^.]{0,40}(?:not supported|unsupported|invalid|no endpoints)|(?:not supported|unsupported|no endpoints found)[^.]{0,40}(?:image|vision|multimodal)|does not support image|modality.*image.*not/i.test(errorText(error));
}
