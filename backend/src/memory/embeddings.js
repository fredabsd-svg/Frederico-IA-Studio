import path from 'path';
import crypto from 'crypto';
import { createCache } from '../cache.js';

// Serviço de embeddings LOCAL (transformers.js): gratuito, privado e sem chave.
// Modelo multilíngue pequeno (~112 MB, baixado uma vez para ./data/models).
// Se o modelo não puder ser carregado (sem internet na 1ª vez, etc.), o app
// entra em modo degradado e a busca semântica vira busca por palavras.
//
// BIBLIOTECA: `@huggingface/transformers` — o sucessor mantido do
// `@xenova/transformers`, que estava parado na 2.17 e carregava a árvore
// vulnerável (protobufjs com execução arbitrária de código, onnxruntime-web,
// onnx-proto). A API que usamos aqui é idêntica nas duas.

const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/multilingual-e5-small';

// QUANTIZAÇÃO FIXA — não é detalhe de performance, é COMPATIBILIDADE DE VETOR.
// O `@xenova/transformers` v2 carregava `model_quantized.onnx` (int8) por
// padrão; o `@huggingface/transformers` v4 passou a carregar `model.onnx`
// (fp32). Deixar o padrão novo teria dois efeitos, os dois ruins:
//   1. os vetores mudariam de valor — e os que já estão gravados no banco e nos
//      artefatos do Docling foram gerados com o modelo quantizado, então a
//      comparação por cosseno passaria a misturar duas escalas diferentes,
//      silenciosamente (sem erro, só recuperação pior);
//   2. o download saltaria de ~113 MB para ~470 MB, com o consumo de memória
//      proporcional — num app que roda em VPS pequena.
// Fixando `q8` usamos exatamente o MESMO arquivo de pesos de antes.
const DTYPE = process.env.EMBEDDING_DTYPE || 'q8';

// Cache de vetores: embeddings são DETERMINÍSTICOS (mesmo texto → mesmo vetor),
// então recomputá-los é puro desperdício de CPU no caminho da resposta. A mesma
// pergunta do usuário é embedada várias vezes por mensagem (busca de memórias +
// busca de trechos + dedupe), e perguntas repetidas entre mensagens são comuns.
// Guardamos por hash de (kind, texto). Cada vetor ocupa ~1,5 KB (384 floats), so
// EMBED_CACHE_MAX=4000 ⇒ ~6 MB de teto. TTL 0 = nunca expira (o modelo é fixo;
// uma troca de modelo dispara reindexação em memoryService).
const EMBED_CACHE_MAX = Math.max(0, Number(process.env.EMBED_CACHE_MAX ?? 4000));
const embedCache = EMBED_CACHE_MAX > 0
  ? createCache({ name: 'embeddings', max: EMBED_CACHE_MAX, ttl: 0 })
  : null;

function embedCacheKey(kind, text) {
  // Hash em vez do texto cru: chave curta e de tamanho fixo mesmo para passagens
  // longas, sem manter cópias do conteúdo original como chave do Map.
  return `${kind}:${crypto.createHash('sha1').update(text).digest('base64')}`;
}
// IDENTIDADE do vetor: tudo que, se mudar, torna os vetores já gravados
// incomparáveis com os novos. Não basta o nome do modelo — a quantização muda
// os valores tanto quanto trocar de modelo. `maybeReindexOnModelChange` compara
// esta string com a guardada em `settings` e dispara a reindexação sozinho.
export const embeddingModelId = `${MODEL}@${DTYPE}`;
// Nome do modelo puro, para exibição/logs (a identidade acima é interna).
export const embeddingModelName = MODEL;

// Quantização usada por TODA versão anterior do app: o `@xenova/transformers`
// carregava o modelo quantizado por padrão, e a identidade gravada era só o nome
// do modelo, sem sufixo. Comparação MEDIDA na migração: os vetores gerados pelo
// `@xenova/transformers@2.17.2` e pelo `@huggingface/transformers@4` com
// `dtype: 'q8'` são BIT A BIT IDÊNTICOS (diferença máxima por componente 0,
// cosseno 1,000000 nos textos de prova). Por isso a identidade sem sufixo é
// aceita como equivalente a `@q8` — do contrário toda instalação existente
// reindexaria a memória inteira sem necessidade nenhuma.
const LEGACY_DTYPE = 'q8';

// A ÚNICA combinação que existiu antes desta migração. Os artefatos do Docling
// gravados no formato antigo (array puro, sem identidade) vieram daqui — o
// chamador passa esta constante em vez de deixar a função adivinhar. Assim, se
// a instalação tiver trocado de modelo OU de quantização, os vetores antigos são
// corretamente recusados em vez de comparados com uma escala diferente.
export const LEGACY_EMBEDDING_IDENTITY = 'Xenova/multilingual-e5-small';

// Uma identidade gravada antes ainda produz vetores comparáveis com os de hoje?
// Função pura: é o que decide entre reaproveitar o que está no banco e reindexar.
// `null`/`undefined` = nada gravado (instalação nova), não "desconhecido": quem
// tem um valor legado precisa passá-lo explicitamente.
export function isEmbeddingIdentityCompatible(stored) {
  if (stored == null || stored === '') return true;  // nada gravado: nada a comparar
  if (stored === embeddingModelId) return true;      // idêntica
  // Formato legado (sem sufixo) equivale ao modelo com a quantização antiga.
  if (!stored.includes('@')) return `${stored}@${LEGACY_DTYPE}` === embeddingModelId;
  return false;
}
let pipePromise = null;
let degraded = false;

async function getPipe() {
  if (degraded) return null;
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env: tenv } = await import('@huggingface/transformers');
      const dataDir = path.resolve(process.env.DATA_DIR || './data');
      tenv.cacheDir = process.env.TRANSFORMERS_CACHE || path.join(dataDir, 'models');
      tenv.allowLocalModels = false;
      return await pipeline('feature-extraction', MODEL, { dtype: DTYPE });
    })().catch(err => {
      console.error('[memória] embeddings indisponíveis (usando busca por palavras):', err.message);
      degraded = true;
      return null;
    });
  }
  return pipePromise;
}

export function embeddingsDegraded() { return degraded; }

// Gera embeddings; kind = 'query' (pergunta) ou 'passage' (conteúdo salvo).
// Retorna Buffers (Float32) ou null por item quando indisponível.
export async function embed(texts, kind = 'passage') {
  const list = texts.map(t => String(t || '').slice(0, 2000));
  // Resolve o que já está em cache; só recomputa os textos faltantes (mantém o
  // batch do modelo, que é mais eficiente do que uma chamada por item).
  const res = new Array(list.length);
  const missIdx = [];
  const missTexts = [];
  for (let i = 0; i < list.length; i++) {
    const hit = embedCache?.get(embedCacheKey(kind, list[i]));
    if (hit !== undefined) res[i] = hit;
    else { missIdx.push(i); missTexts.push(list[i]); }
  }
  if (!missIdx.length) return res;
  const pipe = await getPipe();
  if (!pipe) { for (const i of missIdx) res[i] = null; return res; } // degradado: não cacheia
  try {
    const out = await pipe(missTexts.map(t => `${kind}: ${t}`), { pooling: 'mean', normalize: true });
    const [n, d] = out.dims;
    for (let j = 0; j < n; j++) {
      const vec = out.data.slice(j * d, (j + 1) * d); // cópia (novo ArrayBuffer)
      const buf = Buffer.from(vec.buffer, 0, vec.byteLength);
      res[missIdx[j]] = buf;
      embedCache?.set(embedCacheKey(kind, missTexts[j]), buf); // só guarda sucesso
    }
    // Salvaguarda: se o modelo devolver menos vetores que o esperado, preenche
    // o resto com null (mesma semântica do modo degradado, por item).
    for (const i of missIdx) if (res[i] === undefined) res[i] = null;
    return res;
  } catch (err) {
    console.error('[memória] falha ao gerar embedding:', err.message);
    for (const i of missIdx) res[i] = null;
    return res;
  }
}

export async function embedOne(text, kind = 'passage') {
  return (await embed([text], kind))[0];
}

// Similaridade de cosseno entre dois Buffers Float32 (vetores normalizados)
export function cosine(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength || a.byteLength === 0) return 0;
  const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let s = 0;
  for (let i = 0; i < fa.length; i++) s += fa[i] * fb[i];
  return s;
}

// Fallback sem embeddings: pontuação por palavras compartilhadas
export function keywordScore(query, text) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const qTerms = [...new Set(norm(query).split(/[^a-z0-9]+/).filter(w => w.length > 2))];
  if (!qTerms.length) return 0;
  const t = norm(text);
  let hits = 0;
  for (const w of qTerms) if (t.includes(w)) hits++;
  return hits / qTerms.length;
}
