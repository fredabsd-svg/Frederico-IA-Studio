// A single source of truth for what a model can do in Frederico.
// `null` means that the provider did not publish enough information. It is
// intentionally different from `false`: unknown models can still be tried,
// while known-incompatible models never receive an unsupported parameter.
export const CAPABILITY_KEYS = Object.freeze(['text', 'tools', 'vision', 'image', 'reasoning', 'video']);

const catalog = new Map();

const TOOL_ACTION_RE = /\b(?:gere|crie|monte|produza|faca|construa|execute|rode|leia|analise|edite|salve|exporte|converta|extraia|compacte|baixe|pesquise|busque|consulte|abra|organize|transcreva|renderize|corrija|implemente|teste|verifique|instale|diagnostique|investigue)\b/i;
const TOOL_TARGET_RE = /\b(?:arquivo|planilha|excel|xlsx|word|docx|pdf|documento|relatorio|apresentacao|imagem|foto|video|svg|zip|anexo|upload|pasta|projeto|repositorio|workspace|site|pagina|url|internet|app|aplicativo|codigo|bug|erro|teste|ambiente|servidor|backend|frontend|cnpj|cnae|empresa)\b/i;
const OUTPUT_ACTION_RE = /\b(?:gere|crie|monte|produza|faca|construa|salve|exporte|converta|entregue|baixe)\b/i;
const OUTPUT_TARGET_RE = /\b(?:arquivo|planilha|excel|xlsx|word|docx|pdf|documento|relatorio|apresentacao|imagem|foto|video|svg|zip)\b/i;
const DIRECT_DELIVERY_RE = /\b(?:quero|preciso|gostaria(?:\s+de)?|me\s+(?:entregue|de))\b[\s\S]{0,48}\b(?:arquivo|planilha|excel|xlsx|word|docx|pdf|documento|imagem|foto|video|zip)\b/i;
const UPLOAD_REFERENCE_RE = /\b(?:anexo|anexado|arquivo|planilha|excel|xlsx|word|docx|pdf|documento|imagem|foto|video|isso|isto|este|esta|esse|essa)\b/i;

function normalizedText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Coleta os deslocamentos de todas as ocorr\u00eancias de um padr\u00e3o no texto.
function matchOffsets(re, text) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const rx = new RegExp(re.source, flags);
  const offsets = [];
  let m;
  while ((m = rx.exec(text)) !== null) {
    offsets.push(m.index);
    if (m.index === rx.lastIndex) rx.lastIndex++; // evita loop em match vazio
  }
  return offsets;
}

// Verdadeiro s\u00f3 quando h\u00e1 um verbo de A\u00c7\u00c3O e um ALVO em posi\u00e7\u00f5es DIFERENTES.
// Palavras que est\u00e3o nas duas listas (ex.: "teste") n\u00e3o podem, sozinhas,
// classificar a mensagem como execu\u00e7\u00e3o \u2014 "Teste de controle" deixa de ser
// tratado como pedido de ferramenta, mas "rode o teste" continua sendo.
function hasActionOnTarget(actionRe, targetRe, text) {
  const actions = matchOffsets(actionRe, text);
  if (!actions.length) return false;
  const targets = matchOffsets(targetRe, text);
  if (!targets.length) return false;
  return actions.some(a => targets.some(t => t !== a));
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
  const pricing = model.pricing || {};
  const promptPrice = Number(pricing.prompt ?? model.price ?? 0);
  const completionPrice = Number(pricing.completion ?? 0);
  const hasPricing = Number.isFinite(Number(pricing.prompt)) || Number.isFinite(Number(pricing.completion)) || typeof model.free === 'boolean';

  return {
    id,
    name: model.name || id,
    capabilities,
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
  const expectsOutput = hasActionOnTarget(OUTPUT_ACTION_RE, OUTPUT_TARGET_RE, text) || DIRECT_DELIVERY_RE.test(text);
  if (webSearch) reasons.push('a pesquisa na internet ativada');
  if (developer) reasons.push('o modo desenvolvedor');
  if (hasUploads && UPLOAD_REFERENCE_RE.test(text)) reasons.push('a leitura dos arquivos anexados');
  if (hasActionOnTarget(TOOL_ACTION_RE, TOOL_TARGET_RE, text) || DIRECT_DELIVERY_RE.test(text)) {
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

export function isUnsupportedReasoningError(error) {
  return /reasoning(?: effort| parameter| controls?)?.*(?:not supported|unsupported)|(?:not supported|unsupported).*reasoning/i.test(errorText(error));
}

// O modelo (ou o endpoint escolhido) não aceita imagem na entrada, apesar de
// ter sido tratado como capaz de visão. Nesse caso removemos as imagens e
// caímos para OCR.
export function isUnsupportedVisionError(error) {
  return /image(?:_url)?[^.]{0,40}(?:not supported|unsupported|invalid|no endpoints)|(?:not supported|unsupported|no endpoints found)[^.]{0,40}(?:image|vision|multimodal)|does not support image|modality.*image.*not/i.test(errorText(error));
}
