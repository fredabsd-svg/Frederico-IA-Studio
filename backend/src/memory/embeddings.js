import path from 'path';

// Serviço de embeddings LOCAL (transformers.js): gratuito, privado e sem chave.
// Modelo multilíngue pequeno (~112 MB, baixado uma vez para ./data/models).
// Se o modelo não puder ser carregado (sem internet na 1ª vez, etc.), o app
// entra em modo degradado e a busca semântica vira busca por palavras.

const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/multilingual-e5-small';
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
  const pipe = await getPipe();
  if (!pipe) return list.map(() => null);
  try {
    const out = await pipe(list.map(t => `${kind}: ${t}`), { pooling: 'mean', normalize: true });
    const [n, d] = out.dims;
    const res = [];
    for (let i = 0; i < n; i++) {
      const vec = out.data.slice(i * d, (i + 1) * d); // cópia (novo ArrayBuffer)
      res.push(Buffer.from(vec.buffer, 0, vec.byteLength));
    }
    return res;
  } catch (err) {
    console.error('[memória] falha ao gerar embedding:', err.message);
    return list.map(() => null);
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
