// A single source of truth for what a model can do in Frederico.
// `null` means that the provider did not publish enough information. It is
// intentionally different from `false`: unknown models can still be tried,
// while known-incompatible models never receive an unsupported parameter.
export const CAPABILITY_KEYS = Object.freeze(['text', 'tools', 'vision', 'image', 'reasoning', 'video']);

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

function declaredCapabilities(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    text: capabilityValue(value.text, true),
    tools: capabilityValue(value.tools, null),
    vision: capabilityValue(value.vision, false),
    image: capabilityValue(value.image, false),
    reasoning: capabilityValue(value.reasoning, null),
    video: capabilityValue(value.video, false)
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
    video: output.includes('video')
  }, String(model.id || ''));
}

export function modelProfileFromProvider(model = {}) {
  const id = String(model.id || '');
  const capabilities = deriveModelCapabilities(model);
  const parameters = asStringList(model.supported_parameters);
  const pricing = model.pricing || {};
  const promptPrice = Number(pricing.prompt ?? model.price ?? 0);
  const completionPrice = Number(pricing.completion ?? 0);
  const hasPricing = Number.isFinite(Number(pricing.prompt)) || Number.isFinite(Number(pricing.completion)) || typeof model.free === 'boolean';

  return {
    id,
    name: model.name || id,
    capabilities,
    // null = o provedor não publicou a lista; nesse caso preservamos o
    // comportamento compatível e tentamos os parâmetros comuns. Array = fonte
    // de verdade para não mandar temperature/reasoning/tools a quem não aceita.
    parameters,
    // Flat aliases keep older clients and saved UI state compatible.
    text: capabilities.text,
    tools: capabilities.tools,
    vision: capabilities.vision,
    image: capabilities.image,
    reasoning: capabilities.reasoning,
    video: capabilities.video,
    created: Number(model.created || 0),
    context: Number(model.context_length || model.top_provider?.context_length || model.context || 0),
    price: Number.isFinite(promptPrice) ? promptPrice : 0,
    // Preço por token de SAÍDA (completion) — usado na estimativa e no custo
    // real das execuções multimodelo. `price` acima é o de entrada (prompt).
    priceOut: Number.isFinite(completionPrice) ? completionPrice : 0,
    free: typeof model.free === 'boolean'
      ? model.free
      : id.endsWith(':free') || (hasPricing && promptPrice === 0 && completionPrice === 0)
  };
}

export function registerModelCatalog(models = []) {
  const profiles = models.map(modelProfileFromProvider).filter(model => model.id);
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

// O modelo (ou o endpoint escolhido) não aceita imagem na entrada, apesar de
// ter sido tratado como capaz de visão. Nesse caso removemos as imagens e
// caímos para OCR.
export function isUnsupportedVisionError(error) {
  return /image(?:_url)?[^.]{0,40}(?:not supported|unsupported|invalid|no endpoints)|(?:not supported|unsupported|no endpoints found)[^.]{0,40}(?:image|vision|multimodal)|does not support image|modality.*image.*not/i.test(errorText(error));
}
