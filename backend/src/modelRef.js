const SEPARATOR = '::';

export function makeModelRef(providerId, modelId) {
  const provider = String(providerId || '').trim();
  const model = String(modelId || '').trim();
  return provider && model ? `${provider}${SEPARATOR}${model}` : model;
}

export function parseModelRef(value) {
  const ref = String(value || '').trim();
  const at = ref.indexOf(SEPARATOR);
  if (at <= 0) return { ref, providerId: null, modelId: ref };
  return {
    ref,
    providerId: ref.slice(0, at),
    modelId: ref.slice(at + SEPARATOR.length)
  };
}

export function rawModelId(value) {
  return parseModelRef(value).modelId;
}
