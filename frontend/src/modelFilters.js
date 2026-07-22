export function capabilityOf(model, key) {
  const declared = model?.capabilities;
  if (declared && Object.prototype.hasOwnProperty.call(declared, key)) return declared[key];
  return model?.[key];
}

export function modelFamily(model) {
  if (model?.family) return String(model.family).toLowerCase();
  const id = String(model?.providerModelId || model?.id || '').toLowerCase();
  return id.includes('/') ? id.split('/')[0] : id.split('-')[0];
}

export function filterModels(models, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const flags = Array.isArray(filters.flags) ? filters.flags : [];
  return (models || []).filter(model => {
    const id = String(model.providerModelId || model.id || '');
    const free = model.free === true || id.endsWith(':free');
    const haystack = `${model.name || ''} ${id} ${model.providerName || ''}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (filters.provider && filters.provider !== 'all' && model.providerId !== filters.provider) return false;
    if (filters.family && filters.family !== 'all' && modelFamily(model) !== filters.family) return false;
    if (filters.price === 'free' && !free) return false;
    if (filters.price === 'paid' && (free || !model.pricingKnown)) return false;
    if (filters.price === 'known' && !model.pricingKnown) return false;
    if (filters.context === '32k' && Number(model.context || 0) < 32_000) return false;
    if (filters.context === '100k' && Number(model.context || 0) < 100_000) return false;
    if (filters.context === '1m' && Number(model.context || 0) < 1_000_000) return false;
    if (flags.includes('free') && !free) return false;
    if (flags.includes('configured') && !model.providerId) return false;
    for (const capability of ['tools', 'vision', 'image', 'reasoning', 'video', 'audio', 'web', 'files', 'code', 'embeddings']) {
      if (flags.includes(capability) && capabilityOf(model, capability) !== true) return false;
    }
    return true;
  });
}
