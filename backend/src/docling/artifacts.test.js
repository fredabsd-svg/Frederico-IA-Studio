// Compatibilidade dos vetores gravados nos artefatos do Docling.
//
// Estes vetores ficam FORA do alcance do `reindexAll` (que só cobre memory e
// conversation_chunks) e a chave do cache do Docling (configVersion) não inclui
// o modelo de embeddings. Sem a conferência de identidade testada aqui, trocar
// de modelo ou de quantização faria o app comparar vetores de escalas diferentes
// — sem erro, apenas selecionando os trechos errados do documento.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docling-artifacts-'));
process.env.DOCLING_CACHE_ROOT = tmpRoot;

const { readArtifacts, artifactDir } = await import('./service.js');
const { embeddingModelId } = await import('../memory/embeddings.js');

const USER = 'u1';
const HASH = 'abc123';
const CFG = 'cfg1';

function seedArtifact(embeddingsJson) {
  const dir = artifactDir(USER, HASH, CFG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'optimized.md'), '<!-- page: 1 -->\nConteúdo', 'utf8');
  fs.writeFileSync(path.join(dir, 'chunks.json'), JSON.stringify([{ page: 1, content: 'Conteúdo' }]), 'utf8');
  const target = path.join(dir, 'embeddings.json');
  if (embeddingsJson === null) fs.rmSync(target, { force: true });
  else fs.writeFileSync(target, JSON.stringify(embeddingsJson), 'utf8');
  return dir;
}

const vetor = () => Buffer.from(new Float32Array([0.6, 0.8]).buffer).toString('base64');

test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

test('vetores gravados com a identidade ATUAL são usados', () => {
  seedArtifact({ model: embeddingModelId, vectors: [vetor()] });
  const arts = readArtifacts(USER, HASH, CFG);
  assert.ok(Array.isArray(arts.embeddings), 'deveria devolver os vetores');
  assert.equal(arts.embeddings.length, 1);
  assert.ok(Buffer.isBuffer(arts.embeddings[0]));
});

test('vetores de OUTRA identidade são descartados (não comparados)', () => {
  seedArtifact({ model: 'Xenova/multilingual-e5-small@fp32', vectors: [vetor()] });
  const arts = readArtifacts(USER, HASH, CFG);
  assert.equal(arts.embeddings, null,
    'vetor de outra quantização não pode ser usado — cosseno entre escalas diferentes é ruído');
});

test('vetores de outro MODELO são descartados', () => {
  seedArtifact({ model: 'outro/modelo@q8', vectors: [vetor()] });
  assert.equal(readArtifacts(USER, HASH, CFG).embeddings, null);
});

test('formato ANTIGO (array puro) continua valendo — não força reprocessamento', () => {
  // Instalações que já processaram documentos têm este formato em disco. Ele foi
  // gravado com a única combinação que existia (LEGACY_EMBEDDING_IDENTITY), e a
  // migração mediu que aqueles vetores são idênticos aos de hoje — descartá-los
  // rebaixaria a seleção de trechos sem necessidade nenhuma.
  seedArtifact([vetor()]);
  const arts = readArtifacts(USER, HASH, CFG);
  assert.ok(Array.isArray(arts.embeddings), 'o artefato antigo deve continuar utilizável');
  assert.equal(arts.embeddings.length, 1);
});

test('artefato sem vetores continua funcionando (markdown e chunks intactos)', () => {
  seedArtifact(null);
  const arts = readArtifacts(USER, HASH, CFG);
  assert.equal(arts.embeddings, null);
  assert.match(arts.markdown, /Conteúdo/, 'o conteúdo do documento não pode se perder');
  assert.equal(arts.chunks.length, 1);
});

test('embeddings.json corrompido não derruba a leitura do artefato', () => {
  const dir = seedArtifact({ model: embeddingModelId, vectors: [vetor()] });
  fs.writeFileSync(path.join(dir, 'embeddings.json'), '{ isto não é json', 'utf8');
  const arts = readArtifacts(USER, HASH, CFG);
  assert.equal(arts.embeddings, null);
  assert.match(arts.markdown, /Conteúdo/);
});

test('identidade presente mas sem vetores não quebra', () => {
  seedArtifact({ model: embeddingModelId });
  assert.equal(readArtifacts(USER, HASH, CFG).embeddings, null);
});
