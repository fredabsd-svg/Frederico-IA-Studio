import test from 'node:test';
import assert from 'node:assert/strict';
import { baseModelKey, hasVersionSuffix, versionStamp, metadataCompatible, groupModelVersions } from './modelVersions.js';

test('baseModelKey remove datas e sufixos de versão sem quebrar o nome', () => {
  assert.equal(baseModelKey('qwen3.5-plus-2026-04-20'), 'qwen3.5-plus');
  assert.equal(baseModelKey('qwen3.5-plus-2026-02-15'), 'qwen3.5-plus');
  assert.equal(baseModelKey('qwen3.5-plus'), 'qwen3.5-plus');
  assert.equal(baseModelKey('p1::vendor/codestral-2508'), 'codestral');
  assert.equal(baseModelKey('mistral-large-latest'), 'mistral-large');
  assert.equal(baseModelKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  // Versões que fazem parte do NOME não são tocadas.
  assert.equal(baseModelKey('glm-4.5'), 'glm-4.5');
  assert.equal(baseModelKey('gpt-5.6'), 'gpt-5.6');
});

test('hasVersionSuffix distingue apelido de versão datada', () => {
  assert.equal(hasVersionSuffix('qwen3.5-plus'), false);
  assert.equal(hasVersionSuffix('qwen3.5-plus-2026-04-20'), true);
  assert.equal(hasVersionSuffix('codestral-2508'), true);
  assert.equal(hasVersionSuffix('glm-4.5'), false);
});

test('versionStamp ordena por data extraída do id', () => {
  const a = { providerModelId: 'qwen3.5-plus-2026-04-20' };
  const b = { providerModelId: 'qwen3.5-plus-2026-02-15' };
  assert.ok(versionStamp(a) > versionStamp(b));
  assert.ok(versionStamp({ providerModelId: 'codestral-2508' }) > 0);
});

test('metadataCompatible: desconhecido casa, diferença REAL bloqueia', () => {
  const base = { capabilities: { tools: true, vision: false }, context: 128000, pricingKnown: true, price: 1, priceOut: 2 };
  assert.equal(metadataCompatible(base, { capabilities: { tools: true }, context: 0 }), true, 'contexto desconhecido casa');
  assert.equal(metadataCompatible(base, { capabilities: { tools: true, vision: true } }), false, 'visão diferente bloqueia');
  assert.equal(metadataCompatible(base, { capabilities: {}, context: 256000 }), false, 'contexto diferente bloqueia');
  assert.equal(metadataCompatible(base, { pricingKnown: true, price: 9, capabilities: {} }), false, 'preço diferente bloqueia');
});

const M = (id, extra = {}) => ({ id: `p1::${id}`, providerModelId: id, providerId: 'p1', name: id, capabilities: { tools: true }, ...extra });

test('groupModelVersions: agrupa versões datadas, principal é o apelido sem data', () => {
  const grouped = groupModelVersions([
    M('qwen3.5-plus-2026-02-15'),
    M('qwen3.5-plus'),
    M('qwen3.5-plus-2026-04-20'),
    M('qwen3.6-flash')
  ]);
  assert.equal(grouped.length, 2, 'as 3 versões viram 1 entrada + o flash');
  const principal = grouped.find(m => m.versions);
  assert.equal(principal.providerModelId, 'qwen3.5-plus', 'apelido sem data é a principal');
  assert.equal(principal.versions.length, 2);
  assert.equal(principal.versions[0].providerModelId, 'qwen3.5-plus-2026-04-20', 'anteriores em ordem: mais nova primeiro');
});

test('groupModelVersions: sem apelido, a versão mais RECENTE é a principal', () => {
  const grouped = groupModelVersions([
    M('doubao-seed-1-6-0815'),
    M('kimi-x-2026-01-10'),
    M('kimi-x-2026-06-01')
  ]);
  const kimi = grouped.find(m => String(m.providerModelId).startsWith('kimi'));
  assert.equal(kimi.providerModelId, 'kimi-x-2026-06-01');
  assert.equal(kimi.versions.length, 1);
});

test('groupModelVersions: NÃO mescla entre provedores nem com metadados diferentes', () => {
  const outroProvedor = { ...M('qwen3.5-plus-2026-04-20'), id: 'p2::qwen3.5-plus-2026-04-20', providerId: 'p2' };
  // Diferença CONHECIDA dos dois lados (vision false × true) bloqueia o merge.
  // (Desconhecido de um lado casa — não é "diferença relevante".)
  const base = M('qwen3.5-plus', { capabilities: { tools: true, vision: false } });
  const capDiferente = M('qwen3.5-plus-2026-02-15', { capabilities: { tools: true, vision: true } });
  const grouped = groupModelVersions([base, outroProvedor, capDiferente]);
  assert.equal(grouped.length, 3, 'nada foi agrupado');
  assert.ok(grouped.every(m => !m.versions));
});

test('groupModelVersions: modelos sem sufixo de versão nunca se agrupam entre si', () => {
  const grouped = groupModelVersions([M('glm-4.5'), M('glm-4.5', { id: 'p1::glm-4.5b', providerModelId: 'glm-4.5b' })]);
  assert.equal(grouped.length, 2);
});
