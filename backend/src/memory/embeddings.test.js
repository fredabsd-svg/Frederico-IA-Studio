// Identidade do vetor e compatibilidade entre versões do serviço de embeddings.
//
// Por que estes testes existem: a migração de `@xenova/transformers` para
// `@huggingface/transformers` trocou o padrão de quantização (int8 → fp32). Se
// isso passar despercebido, os vetores gravados no banco e nos artefatos do
// Docling deixam de ser comparáveis com os novos — SEM erro nenhum, só
// recuperação semântica pior. Estes testes prendem as duas defesas: a identidade
// que dispara a reindexação e o formato dos vetores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddingModelId, embeddingModelName, cosine, keywordScore,
  isEmbeddingIdentityCompatible, LEGACY_EMBEDDING_IDENTITY } from './embeddings.js';

test('a identidade do vetor inclui o modelo E a quantização', () => {
  // Só o nome do modelo não basta: trocar a quantização muda os valores tanto
  // quanto trocar de modelo, e `maybeReindexOnModelChange` compara esta string.
  assert.ok(embeddingModelId.includes(embeddingModelName), 'deve conter o modelo');
  assert.match(embeddingModelId, /@[a-z0-9]+$/i, 'deve terminar com a quantização');
  assert.notEqual(embeddingModelId, embeddingModelName, 'identidade e nome não podem coincidir');
});

test('a quantização padrão é a mesma que a biblioteca antiga usava (q8)', () => {
  // `q8` = model_quantized.onnx (~113 MB), o arquivo que o @xenova/transformers
  // carregava por padrão. O padrão novo (fp32, ~470 MB) mudaria os vetores e
  // quadruplicaria o download.
  assert.match(embeddingModelId, /@q8$/, 'sem q8, os vetores gravados ficam incomparáveis');
});

test('trocar a quantização muda a identidade (dispara reindexação)', async () => {
  const original = process.env.EMBEDDING_DTYPE;
  process.env.EMBEDDING_DTYPE = 'fp32';
  // Import com cache-buster: o módulo lê o ambiente no carregamento.
  const outro = await import(`./embeddings.js?v=${Date.now()}`);
  assert.notEqual(outro.embeddingModelId, embeddingModelId,
    'mudar a quantização PRECISA mudar a identidade, senão a reindexação não acontece');
  assert.match(outro.embeddingModelId, /@fp32$/);
  if (original === undefined) delete process.env.EMBEDDING_DTYPE;
  else process.env.EMBEDDING_DTYPE = original;
});

// ---- compatibilidade retroativa: quando NÃO reindexar ----------------------

test('a identidade legada (sem sufixo) é compatível — não força reindexação', () => {
  // Medido na migração: os vetores do @xenova/transformers@2.17.2 e do
  // @huggingface/transformers@4 com dtype q8 são bit a bit idênticos. Reindexar
  // a memória de toda instalação existente seria desperdício puro.
  assert.equal(isEmbeddingIdentityCompatible(LEGACY_EMBEDDING_IDENTITY), true);
  assert.equal(isEmbeddingIdentityCompatible(embeddingModelName), true);
});

test('identidade idêntica é compatível; instalação nova (sem valor) também', () => {
  assert.equal(isEmbeddingIdentityCompatible(embeddingModelId), true);
  assert.equal(isEmbeddingIdentityCompatible(null), true);
  assert.equal(isEmbeddingIdentityCompatible(undefined), true);
  assert.equal(isEmbeddingIdentityCompatible(''), true);
});

test('outra quantização do MESMO modelo é incompatível (reindexa)', () => {
  assert.equal(isEmbeddingIdentityCompatible(`${embeddingModelName}@fp32`), false);
  assert.equal(isEmbeddingIdentityCompatible(`${embeddingModelName}@fp16`), false);
});

test('outro modelo é incompatível, com ou sem sufixo', () => {
  assert.equal(isEmbeddingIdentityCompatible('outro/modelo@q8'), false);
  assert.equal(isEmbeddingIdentityCompatible('outro/modelo'), false);
});

// ---- cosseno: a defesa contra comparar vetores de tamanhos diferentes -------

test('cosine devolve 0 para vetores de dimensões diferentes', () => {
  const a = Buffer.from(new Float32Array([1, 0, 0]).buffer);
  const b = Buffer.from(new Float32Array([1, 0]).buffer);
  assert.equal(cosine(a, b), 0, 'dimensões diferentes não podem produzir similaridade');
});

test('cosine de vetores normalizados iguais é 1', () => {
  const v = new Float32Array([0.6, 0.8]);
  const a = Buffer.from(v.buffer.slice(0));
  const b = Buffer.from(v.buffer.slice(0));
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
});

test('cosine é 0 para vetores ortogonais e negativo para opostos', () => {
  const buf = (arr) => Buffer.from(new Float32Array(arr).buffer.slice(0));
  assert.ok(Math.abs(cosine(buf([1, 0]), buf([0, 1]))) < 1e-6);
  assert.ok(cosine(buf([1, 0]), buf([-1, 0])) < 0);
});

test('cosine trata entradas ausentes/vazias sem lançar', () => {
  const v = Buffer.from(new Float32Array([1, 0]).buffer);
  for (const [a, b] of [[null, v], [v, null], [null, null], [Buffer.alloc(0), Buffer.alloc(0)]]) {
    assert.equal(cosine(a, b), 0);
  }
});

// ---- fallback por palavras: o caminho quando os vetores não servem ----------

test('keywordScore pontua pela fração de termos encontrados', () => {
  assert.equal(keywordScore('lucro liquido', 'o lucro liquido do periodo'), 1);
  assert.equal(keywordScore('lucro prejuizo', 'apenas o lucro apareceu'), 0.5);
  assert.equal(keywordScore('inexistente', 'texto qualquer'), 0);
});

test('keywordScore ignora acentuação e caixa', () => {
  assert.equal(keywordScore('LUCRO LÍQUIDO', 'o lucro liquido apurado'), 1);
});

test('keywordScore sem termos úteis devolve 0 em vez de dividir por zero', () => {
  assert.equal(keywordScore('a de o', 'qualquer texto'), 0);
  assert.equal(keywordScore('', 'qualquer texto'), 0);
});
