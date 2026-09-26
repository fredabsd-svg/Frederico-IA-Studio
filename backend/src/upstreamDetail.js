// Saneamento de texto vindo de um provedor externo (corpo de erro de API).
//
// Módulo-folha de propósito (sem dependências): é usado tanto pelo catálogo de
// provedores (providerCatalog.js) quanto pela tradução de erros do agente
// (agent/provider.js), e importar o catálogo inteiro no caminho do agente
// arrastaria tools.js e ciclos de import.
//
// Texto vindo do provedor é conteúdo NÃO confiável: pode ser HTML de um proxy,
// um stack trace ou o corpo de um serviço interno. Só uma frase curta, sem
// tags nem quebras, chega ao usuário — e nada com cara de chave de API
// (Regra 6.2: alguns provedores ecoam parte da chave recusada).
export function sanitizeUpstreamDetail(value, max = 160) {
  const text = typeof value === 'string' ? value : (value && typeof value === 'object' ? String(value.message || '') : '');
  const clean = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, '$1-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
