// Fábrica única do cliente OpenAI (usado para DeepSeek e OpenRouter).
//
// PORQUÊ: o OpenRouter identifica cada app pelos cabeçalhos HTTP-Referer
// (URL do app) e X-Title (nome exibido). Sem eles, todas as chamadas chegam
// sem identificação e o app aparece como "desconhecido" nos Registros/Activity
// do OpenRouter. Centralizar a criação do cliente aqui garante que TODO ponto
// que fala com o provedor (chat, embeddings, teste de chave) envie a mesma
// identificação — sem repetir código nem esquecer algum lugar.
import OpenAI from 'openai';

const APP_TITLE = process.env.OPENROUTER_APP_TITLE || 'Frederico IA Studio';
// URL pública do app: usa a origem já configurada como padrão, evitando pedir
// mais uma variável só para isso. Preferimos BETTER_AUTH_URL porque em produção
// o docker-compose a define a partir do DOMAIN (https://SEU_DOMINIO); só depois
// caímos para FRONTEND_URL, que no .env.example ainda é localhost e, se herdado
// na VPS, marcaria o app com uma URL de desenvolvimento no OpenRouter.
const APP_URL = process.env.OPENROUTER_APP_URL
  || process.env.BETTER_AUTH_URL
  || process.env.FRONTEND_URL
  || 'http://localhost:5173';

// Só faz sentido mandar os cabeçalhos de atribuição para o OpenRouter; a API
// nativa da DeepSeek simplesmente os ignora, mas evitamos ruído mandando só
// quando a base URL é de fato do OpenRouter.
export function openRouterAttributionHeaders(baseURL) {
  if (!/openrouter\.ai/i.test(String(baseURL || ''))) return {};
  return { 'HTTP-Referer': APP_URL, 'X-Title': APP_TITLE };
}

// Cria um cliente OpenAI já com a atribuição do OpenRouter injetada.
// Aceita as mesmas opções do construtor da OpenAI; defaultHeaders extras
// passados pelo chamador são preservados.
export function createAiClient({ apiKey, baseURL, defaultHeaders, ...rest } = {}) {
  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: { ...openRouterAttributionHeaders(baseURL), ...defaultHeaders },
    ...rest,
  });
}
