// Geração de imagem: QUAL credencial atende?
//
// O caminho implementado no app é o do OpenRouter — POST /chat/completions com
// `modalities: ['image','text']` e a imagem de volta em
// `choices[0].message.images`. Um endpoint OpenAI-compatível qualquer NÃO faz
// isso: DeepSeek, Groq e Mistral respondem só texto.
//
// Antes, `generate_image` resolvia a credencial com a referência de modelo
// VAZIA, e `getUserProvider` nesse caso cai no provedor mais ANTIGO da conta.
// Duas consequências, as duas vistas em uso real:
//
//   * numa conta com mais de uma chave, a imagem saía pela chave errada (base
//     da DeepSeek + modelo da OpenRouter = 404 ou "modelo desconhecido");
//   * quando esse provedor mais antigo não tinha chave utilizável, o usuário
//     lia "Nenhuma chave de API configurada" — com o chat respondendo na MESMA
//     tela, pela chave de outro provedor. A mensagem mandava cadastrar o que
//     já estava cadastrado.
//
// Aqui a escolha é por CAPACIDADE: entre as chaves da conta, vale a que tem
// modelo de geração de imagem no catálogo importado do provedor (preferindo a
// do modelo ativo no chat). Quando nenhuma tem, o erro diz o que de fato falta
// em vez de culpar a ausência de chave.
import { modelProfileFromProvider } from './modelCapabilities.js';
import { rawModelId } from './modelRef.js';
import { getUserProvider, listUserProviders } from './userProvider.js';

// Preferência quando o catálogo oferece mais de um modelo de imagem. O resto da
// lista vem do próprio catálogo do provedor — ele é a fonte de verdade sobre o
// que existe hoje; uma lista fixa aqui envelheceria em silêncio.
export const PREFERRED_IMAGE_MODELS = Object.freeze([
  'google/gemini-2.5-flash-image',
  'google/gemini-2.5-flash-image-preview'
]);

function envImageModel() {
  return String(process.env.IMAGE_MODEL || '').trim();
}

// Modelos do catálogo do provedor que GERAM imagem. `capabilities.image` vem de
// `architecture.output_modalities` (o OpenRouter publica), não de
// `input_modalities` — aceitar imagem na entrada é visão, coisa diferente.
export function catalogImageModels(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return models
    .filter(model => modelProfileFromProvider(model).image === true)
    .map(model => String(model.id || ''))
    .filter(Boolean);
}

// Qual modelo de imagem usar NESTE provedor — '' quando ele não serve.
export function imageModelFor(provider, envModel = '') {
  const ids = catalogImageModels(provider);
  if (envModel) {
    if (ids.includes(envModel)) return envModel;
    // O catálogo não lista o modelo que o operador impôs. Só aceitamos a
    // imposição quando o provedor não publicou catálogo nenhum (o caso do
    // endpoint sem GET /models, validado por um modelo único) E é um OpenRouter
    // — em outro provedor isso seria um 404 disfarçado de configuração.
    return !ids.length && provider?.providerType === 'openrouter' ? envModel : '';
  }
  for (const preferred of PREFERRED_IMAGE_MODELS) {
    if (ids.includes(preferred)) return preferred;
  }
  return ids[0] || '';
}

// PURA: dado o conjunto de provedores COM chave, decide quem gera a imagem.
// O provedor do modelo ativo no chat vem primeiro — se ele serve, a imagem sai
// pela mesma credencial que o usuário está usando e vendo cobrar.
export function chooseImageProvider(providers = [], { envModel = '', activeId = '' } = {}) {
  const ordered = [
    ...providers.filter(provider => provider?.id && provider.id === activeId),
    ...providers.filter(provider => !provider?.id || provider.id !== activeId)
  ];
  for (const provider of ordered) {
    const model = imageModelFor(provider, envModel);
    if (model) return { provider, model };
  }
  return null;
}

function providerNames(providers) {
  const names = [...new Set(providers.map(p => String(p.providerName || p.providerType || 'provedor')))];
  return names.join(', ');
}

// Modo gratuito: a chave é da PLATAFORMA e os modelos de imagem são pagos. Só
// geramos imagem com ela quando o operador colocou um modelo de imagem na
// allowlist gratuita (FREE_TIER_MODELS) — sem essa checagem o usuário gastaria
// a chave da casa exatamente no que a allowlist existe para impedir.
function freeImageModel(active, envModel) {
  if (active?.source !== 'free' || !active.hasKey) return '';
  const ids = (active.freeModels || []).map(rawModelId);
  if (envModel) return ids.includes(envModel) ? envModel : '';
  return PREFERRED_IMAGE_MODELS.find(id => ids.includes(id)) || '';
}

// Resolve a credencial de imagem do usuário. Devolve `{ provider, model }` ou
// `{ error, code }` — nunca lança.
export async function resolveImageProvider(userId, modelRef = '') {
  const envModel = envImageModel();
  const [active, providers] = await Promise.all([
    getUserProvider(userId, modelRef),
    listUserProviders(userId)
  ]);

  const choice = chooseImageProvider(providers, { envModel, activeId: active.id });
  if (choice) return choice;

  const freeModel = freeImageModel(active, envModel);
  if (freeModel) return { provider: active, model: freeModel };

  if (providers.length) {
    return {
      code: 'IMAGE_SEM_PROVEDOR',
      error: `Nenhuma das suas chaves gera imagem. Você tem ${providerNames(providers)}, e a geração de imagem exige um provedor que devolva imagem no /chat/completions — na prática, o OpenRouter. Cadastre uma chave dele em Configurações → Provedor de IA (a chave atual continua valendo para o chat).`
    };
  }
  if (active.source === 'free' && active.hasKey) {
    return {
      code: 'IMAGE_MODO_GRATUITO',
      error: 'O modo gratuito não gera imagens: os modelos de imagem são pagos e a chave é da plataforma. Cadastre a sua chave (OpenRouter, por exemplo) em Configurações → Provedor de IA para gerar imagens.'
    };
  }
  return {
    code: 'NO_API_KEY',
    error: 'Nenhuma chave de API configurada para gerar imagens. Cadastre a sua chave em Configurações → Provedor de IA.'
  };
}
