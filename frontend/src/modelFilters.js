import { findRanking, tierScore } from './modelRanking.js';

export function capabilityOf(model, key) {
  const declared = model?.capabilities;
  if (declared && Object.prototype.hasOwnProperty.call(declared, key)) return declared[key];
  return model?.[key];
}

// Classificação efetiva do modelo (backend > lista de nomes). null se sem selo.
export function tierOf(model) {
  return findRanking(model)?.tier || null;
}

// Modalidade macro do modelo, para o filtro por modalidade.
//   multimodal = entende imagem/áudio/vídeo na entrada
//   image/audio/video = GERA aquela mídia
//   text = conversa por texto (sem multimodalidade de entrada)
export function matchesModality(model, modality) {
  if (!modality || modality === 'all') return true;
  const cap = k => capabilityOf(model, k) === true;
  if (modality === 'multimodal') return cap('vision') || cap('audio') || cap('video');
  if (modality === 'text') return !(cap('vision') || cap('audio') || cap('video') || cap('image'));
  if (modality === 'image') return cap('image');       // geração de imagem
  if (modality === 'audio') return cap('audio');
  if (modality === 'video') return cap('video');
  if (modality === 'vision') return cap('vision');     // lê imagens
  return true;
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
    // Classificação: EXATA por padrão ('A' mostra só A). O prefixo '>=' pede a
    // variante "ou acima" ('>=A' mostra A, A+, S e S+). Sem selo → fica de fora.
    if (filters.tier && filters.tier !== 'all') {
      const modelTier = tierOf(model);
      if (filters.tier.startsWith('>=')) {
        if (tierScore(modelTier) < tierScore(filters.tier.slice(2))) return false;
      } else if (modelTier !== filters.tier) return false;
    }
    // Modalidade (multimodal / texto / gera imagem·áudio·vídeo / lê imagens).
    if (filters.modality && filters.modality !== 'all' && !matchesModality(model, filters.modality)) return false;
    if (flags.includes('free') && !free) return false;
    if (flags.includes('configured') && !model.providerId) return false;
    for (const capability of ['tools', 'vision', 'image', 'reasoning', 'video', 'audio', 'web', 'files', 'code', 'embeddings']) {
      if (flags.includes(capability) && capabilityOf(model, capability) !== true) return false;
    }
    return true;
  });
}
