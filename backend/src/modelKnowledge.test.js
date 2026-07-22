import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bareModelId, normalizeKey, mergeCapabilities, classifyModel, providerSource
} from './modelKnowledge.js';

test('bareModelId remove referência interna e vendor do OpenRouter', () => {
  assert.equal(bareModelId('deepseek::deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(bareModelId('google/gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(bareModelId('pid123::z-ai/glm-4.6'), 'glm-4.6');
  assert.equal(bareModelId('codestral-2508'), 'codestral-2508');
});

test('normalizeKey tira acento, data, sufixos e pontuação', () => {
  assert.equal(normalizeKey('Gemini 2.5 Pro'), 'gemini 2 5 pro');
  assert.equal(normalizeKey('glm-4.6:free'), 'glm 4 6');
  assert.equal(normalizeKey('DeepSeek-V4-Pro-2026-07'), 'deepseek v4 pro');
});

test('mergeCapabilities: fonte oficial confirma recurso que a API omitiu', () => {
  // Gemini via API pelada: tools/vision desconhecidos (null). Curado confirma.
  const api = { text: true, tools: null, vision: null, reasoning: null };
  const curated = { capabilities: { tools: true, vision: true, reasoning: true } };
  const out = mergeCapabilities(api, curated, null);
  assert.equal(out.tools, true);
  assert.equal(out.vision, true);
  assert.equal(out.reasoning, true);
  assert.equal(out.text, true);
});

test('mergeCapabilities: API que AFIRMA vence, curado não rebaixa indevidamente', () => {
  // A API diz explicitamente que NÃO tem visão; curado calou → respeita a API.
  const api = { text: true, vision: false, tools: true };
  const out = mergeCapabilities(api, { capabilities: {} }, null);
  assert.equal(out.vision, false);
  assert.equal(out.tools, true);
});

test('mergeCapabilities: cai para o piso de família quando API e curado calam', () => {
  const api = { text: true, tools: null, vision: null };
  const family = { capabilities: { tools: true, vision: true } };
  const out = mergeCapabilities(api, null, family);
  assert.equal(out.tools, true);
  assert.equal(out.vision, true);
});

test('mergeCapabilities: curado nega explicitamente', () => {
  const out = mergeCapabilities({ text: true, tools: null }, { capabilities: { tools: false } }, { capabilities: { tools: true } });
  assert.equal(out.tools, false, 'negação curada vence o piso de família');
});

test('classifyModel: só-texto sem ferramentas/raciocínio nunca passa de B+', () => {
  const { tier } = classifyModel({ capabilities: { text: true, tools: false, reasoning: false }, context: 32000 });
  assert.ok(['C', 'B', 'B+'].includes(tier), `esperava até B+, veio ${tier}`);
});

test('classifyModel: coerência — só-texto NÃO pode ser S+ mesmo com tierHint alto', () => {
  // O bug relatado: GLM marcado S+ mas "só texto". Com capacidades só-texto,
  // o teto de coerência impede S+ (no máximo S, e só se tiver ferramentas).
  const semFerramenta = classifyModel({ capabilities: { text: true, tools: false, reasoning: false }, tierHint: 'S+' });
  assert.notEqual(semFerramenta.tier, 'S+');
  assert.notEqual(semFerramenta.tier, 'S');
  // Com ferramentas mas sem multimodalidade: no máximo S (não S+).
  const comFerramenta = classifyModel({ capabilities: { text: true, tools: true }, tierHint: 'S+', context: 128000 });
  assert.notEqual(comFerramenta.tier, 'S+');
});

test('classifyModel: modelo multimodal com raciocínio e ferramentas alcança faixa alta', () => {
  const { tier, rank } = classifyModel({
    capabilities: { text: true, tools: true, vision: true, reasoning: true, audio: true },
    context: 1_000_000,
    tierHint: 'S+'
  });
  assert.equal(tier, 'S+');
  assert.ok(rank >= 5);
});

test('classifyModel: tierHint eleva o piso, capacidade dá o teto', () => {
  // Sem hint, um modelo com ferramentas + visão + 200k já é bom, mas o hint
  // curado pode elevar dentro do que a coerência permite.
  const semHint = classifyModel({ capabilities: { text: true, tools: true, vision: true }, context: 200000 });
  const comHint = classifyModel({ capabilities: { text: true, tools: true, vision: true }, context: 200000, tierHint: 'S+' });
  assert.ok(comHint.rank >= semHint.rank);
});

test('providerSource devolve fontes oficiais conhecidas e cai para custom', () => {
  assert.match(providerSource('gemini').officialDocs[0], /ai\.google\.dev/);
  assert.equal(providerSource('desconhecido').label, 'OpenAI compatível');
  assert.equal(providerSource('openrouter').richCatalog, true);
});
