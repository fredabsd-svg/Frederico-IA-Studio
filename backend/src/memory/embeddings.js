import path from 'path';
import crypto from 'crypto';
import { createCache } from '../cache.js';

// Serviço de embeddings LOCAL (transformers.js): gratuito, privado e sem chave.
// Modelo multilíngue pequeno (~112 MB, baixado uma vez para ./data/models).
// Se o modelo não puder ser carregado (sem internet na 1ª vez, etc.), o app
// entra em modo degradado e a busca semântica vira busca por palavras.

const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/multilingual-e5-small';

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
export const embeddingModelId = MODEL;
let pipePromise = null;
let degraded = false;

async function getPipe() {
  if (degraded) return null;
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env: tenv } = await import('@xenova/transformers');
      const dataDir = path.resolve(process.env.DATA_DIR || './data');
      tenv.cacheDir = process.env.TRANSFORMERS_CACHE || path.join(dataDir, 'models');
      tenv.allowLocalModels = false;
      return await pipeline('feature-extraction', MODEL);
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
