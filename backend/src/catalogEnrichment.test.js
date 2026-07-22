// Integração: prova que os problemas relatados pelo usuário estão corrigidos.
// Simula o pior caso — a API do provedor devolve só o ID "pelado", sem
// modalidades, sem supported_parameters, sem nome nem preço. Antes disso tudo
// virava "só texto" e sem classificação. Agora a base curada corrige.
import assert from 'node:assert/strict';
import test from 'node:test';
import { modelProfileFromProvider } from './modelCapabilities.js';

const bare = (id, extra = {}) => modelProfileFromProvider({ id, ...extra });

test('Gemini NÃO é mais "só texto" — herda visão, ferramentas e raciocínio', () => {
  const p = bare('gemini-2.5-pro');
  assert.equal(p.vision, true, 'Gemini vê imagens');
  assert.equal(p.tools, true, 'Gemini usa ferramentas');
  assert.equal(p.reasoning, true, 'Gemini raciocina');
  assert.equal(p.audio, true);
  assert.equal(p.video, true);
  assert.equal(p.family, 'Gemini 2.5');
  assert.ok(['S', 'S+', 'A+'].includes(p.tier), `tier coerente, veio ${p.tier}`);
});

test('GLM: bug "S+ mas só texto" resolvido — capacidades certas E tier coerente', () => {
  const glm52 = bare('glm-5.2');
  assert.equal(glm52.tools, true, 'GLM usa ferramentas (não é só texto)');
  assert.equal(glm52.reasoning, true);
  // Coerência: GLM-5.2 é texto+ferramentas SEM multimodalidade → no máximo S,
  // NUNCA S+ (era exatamente a incoerência relatada).
  assert.notEqual(glm52.tier, 'S+');
  assert.ok(['S', 'A+'].includes(glm52.tier), `veio ${glm52.tier}`);
  // GLM com visão é reconhecido como multimodal.
  const glmv = bare('glm-4.5v');
  assert.equal(glmv.vision, true);
  assert.equal(glmv.video, true);
});

test('Codestral (o do print): tem ferramentas e código, e NÃO é super-classificado', () => {
  const p = bare('codestral-2508');
  assert.equal(p.tools, true);
  assert.equal(p.code, true);
  assert.equal(p.vision, false);
  assert.equal(p.family, 'Mistral Codestral');
  assert.ok(!['S+', 'S'].includes(p.tier), `especialista de código não deve ser S/S+, veio ${p.tier}`);
});

test('Claude Opus 4.8: multimodal + raciocínio → S+ coerente', () => {
  const p = bare('claude-opus-4-8');
  assert.equal(p.vision, true);
  assert.equal(p.tools, true);
  assert.equal(p.reasoning, true);
  assert.equal(p.tier, 'S+');
  assert.equal(p.commercialName ?? p.name, 'Claude Opus 4.8');
});

test('procedência preenchida: fonte oficial, data e confiança', () => {
  const p = bare('gemini-2.5-pro');
  assert.match(p.source || '', /ai\.google\.dev/);
  assert.equal(p.verifiedAt, '2026-07-22');
  assert.equal(p.confidence, 'high');
  assert.equal(p.metadataSource, 'curated');
  assert.equal(p.streaming, true);
  assert.deepEqual(p.inputFormats, ['text', 'image', 'audio', 'video', 'pdf']);
});

test('status/substituto de modelos depreciados', () => {
  const gemini2 = bare('gemini-2.0-flash');
  assert.equal(gemini2.status, 'deprecated');
  assert.equal(gemini2.replacement, 'gemini-3.6-flash');
  const opus41 = bare('claude-opus-4-1');
  assert.equal(opus41.status, 'deprecated');
  assert.equal(opus41.replacement, 'claude-opus-4-8');
});

test('funciona mesmo com referência interna e prefixo de vendor do OpenRouter', () => {
  const p = modelProfileFromProvider({ id: 'pid9::z-ai/glm-4.6', providerModelId: 'z-ai/glm-4.6' });
  assert.equal(p.tools, true, 'casou GLM-4.6 apesar do prefixo');
  assert.equal(p.family, 'GLM-4.x');
});

test('a API que AFIRMA um recurso ainda vence (não é engessado pelo curado)', () => {
  // Um modelo Gemini hipotético que a API declara SEM ferramentas: respeitado.
  const p = modelProfileFromProvider({
    id: 'gemini-2.5-flash', capabilities: { text: true, tools: false }
  });
  assert.equal(p.tools, false, 'declaração explícita da API prevalece');
});

test('contexto e preço da API têm prioridade quando presentes; senão entra o curado', () => {
  // Sem dados da API → usa o curado (Gemini 2.5 Pro: 1.048.576 ctx).
  const curado = bare('gemini-2.5-pro');
  assert.equal(curado.context, 1048576);
  assert.ok(curado.price > 0 && curado.pricingKnown);
  // Com contexto da API → a API vence.
  const daApi = bare('gemini-2.5-pro', { context_length: 500000 });
  assert.equal(daApi.context, 500000);
});
