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

test('famílias novas: capacidades e classificação coerentes', () => {
  // Sonar (Perplexity): a pesquisa web é a capacidade principal — conta como
  // profundidade, então não fica preso em B+.
  const sonar = bare('sonar-pro');
  assert.equal(sonar.web, true);
  assert.ok(['A', 'A+'].includes(sonar.tier), `Sonar Pro coerente, veio ${sonar.tier}`);
  // Nova Pro (Amazon): multimodal (visão + vídeo).
  const nova = bare('amazon.nova-pro-v1:0');
  assert.equal(nova.vision, true);
  assert.equal(nova.video, true);
  assert.equal(nova.family, 'Nova 1');
  // MiMo V2.5 (Xiaomi): omnimodal.
  const mimo = bare('XiaomiMiMo/MiMo-V2.5');
  assert.equal(mimo.vision, true);
  assert.equal(mimo.audio, true);
  // Kimi K3 flagship.
  assert.equal(bare('kimi-k3').tier, 'S');
});

test('tierHint é autoritativo: amplitude de capacidades não infla o tier', () => {
  // Um modelo pequeno multimodal (hint A) não vira S só por marcar caixas.
  const nano = bare('nvidia/nemotron-3-nano-omni-30b-a3b');
  assert.equal(nano.vision, true);
  assert.equal(nano.tier, 'A', `hint A respeitado, veio ${nano.tier}`);
});

// Bug relatado: Auto Router exibia "-$1.000.000/1M" (sentinela -1 do OpenRouter
// interpretada como preço por token) e valores em unidade errada viravam
// absurdos. Preço fora da faixa plausível NUNCA vira número na tela.
test('sanidade de preços: sentinela -1 vira "preço variável", nunca negativo', () => {
  const auto = modelProfileFromProvider({ id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } });
  assert.equal(auto.pricingKnown, false);
  assert.equal(auto.price, 0);
  assert.equal(auto.priceOut, 0);
  assert.equal(auto.pricingVariable, true);
  assert.equal(auto.free, false, 'preço desconhecido não é grátis');
});

test('sanidade de preços: unidade errada (por-1M como por-token) é descartada', () => {
  // "5" por token = $5.000.000/1M — obviamente unidade errada.
  const errado = modelProfileFromProvider({ id: 'x/unidade-errada', pricing: { prompt: '5', completion: '10' } });
  assert.equal(errado.pricingKnown, false);
  assert.equal(errado.price, 0);
  // Valor são por token passa normalmente.
  const ok = modelProfileFromProvider({ id: 'x/preco-sao', pricing: { prompt: '0.000005', completion: '0.000015' } });
  assert.equal(ok.pricingKnown, true);
  assert.ok(Math.abs(ok.price - 0.000005) < 1e-12);
  assert.equal(ok.priceSource, 'provider_api');
});

test('sanidade de preços: API inválida cai para o preço oficial curado, com data', () => {
  const gem = modelProfileFromProvider({ id: 'gemini-2.5-pro', pricing: { prompt: '-1' } });
  assert.equal(gem.pricingKnown, true, 'usa o preço curado');
  assert.ok(gem.price > 0 && gem.price <= 0.001);
  assert.equal(gem.priceSource, 'curated');
  assert.equal(gem.priceVerifiedAt, '2026-07-22');
  assert.equal(gem.pricingVariable, false, 'com preço confiável, não é "variável"');
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
