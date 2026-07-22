import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelCallPlan,
  detectToolRequirement,
  isUnsupportedToolError,
  isUnsupportedVisionError,
  modelCompatibilityMessage,
  modelProfileFromProvider,
  registerModelCatalog,
  getModelProfile,
  deriveModelCapabilities
} from './modelCapabilities.js';

test('catálogos de provedores diferentes não colidem quando o model id é igual', () => {
  registerModelCatalog([{ id: 'shared/model', name: 'Modelo na NVIDIA' }], {
    providerId: 'nvidia-key', providerName: 'NVIDIA', providerType: 'nvidia'
  });
  registerModelCatalog([{ id: 'shared/model', name: 'Modelo na OpenRouter' }], {
    providerId: 'openrouter-key', providerName: 'OpenRouter', providerType: 'openrouter'
  });
  assert.equal(getModelProfile('nvidia-key::shared/model').name, 'Modelo na NVIDIA');
  assert.equal(getModelProfile('openrouter-key::shared/model').name, 'Modelo na OpenRouter');
  assert.equal(getModelProfile('nvidia-key::shared/model').providerModelId, 'shared/model');
});

const granite = modelProfileFromProvider({
  id: 'ibm-granite/granite-4.0-h-micro',
  name: 'IBM: Granite 4.0 Micro',
  supported_parameters: ['max_tokens', 'temperature'],
  architecture: { input_modalities: ['text'], output_modalities: ['text'] }
});

test('declares the Granite micro capabilities from the provider catalog', () => {
  assert.deepEqual(granite.capabilities, {
    text: true,
    tools: false,
    vision: false,
    image: false,
    reasoning: false,
    video: false
  });
});

test('uses a text-only fallback for a normal question on a model without tools', () => {
  const plan = buildModelCallPlan({
    profile: granite,
    tools: [{ type: 'function', function: { name: 'run_python' } }],
    userText: 'Explique como uma planilha funciona.',
    reasoningEffort: 'high'
  });

  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.tools, []);
  assert.equal(plan.reasoning, null);
  assert.equal(plan.degraded.tools, true);
});

test('blocks a real file request before sending unsupported tools to the model', () => {
  const plan = buildModelCallPlan({
    profile: granite,
    tools: [{ type: 'function', function: { name: 'run_python' } }],
    userText: 'Gere uma planilha Excel com estes dados.'
  });

  assert.deepEqual(plan.blocked, { capability: 'tools' });
  assert.match(modelCompatibilityMessage(plan), /Ferramentas/);
});

test('keeps compatible tools and reasoning controls for capable models', () => {
  const capable = modelProfileFromProvider({
    id: 'example/capable-model',
    supported_parameters: ['tools', 'reasoning', 'temperature'],
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }
  });
  const tools = [{ type: 'function', function: { name: 'run_python' } }];
  const plan = buildModelCallPlan({
    profile: capable,
    tools,
    userText: 'Gere uma planilha Excel com estes dados.',
    reasoningEffort: 'high'
  });

  assert.equal(plan.blocked, null);
  assert.equal(plan.tools, tools);
  assert.equal(plan.reasoning, 'high');
  assert.equal(plan.capabilities.vision, true);
});

test('does not treat an old upload as a mandatory tool request without a file reference', () => {
  assert.equal(detectToolRequirement({ userText: 'Qual e a capital do Brasil?', hasUploads: true }).required, false);
  assert.equal(detectToolRequirement({ userText: 'Leia o PDF anexado.', hasUploads: true }).required, true);
});

test('recognizes a document delivery request as execution that must create an output', () => {
  const requirement = detectToolRequirement({
    userText: 'Crie um relatorio profissional completo em formato DOCX sobre o ambiente e o aplicativo.'
  });

  assert.equal(requirement.required, true);
  assert.equal(requirement.expectsOutput, true);
});

test('reconhece verbos usuais de elaboração de Word/PDF como execução de arquivo', () => {
  for (const userText of [
    'Elabore um documento Word com base nos PDFs anexados.',
    'Prepare um relatório PDF profissional.',
    'Consolide estes documentos em um DOCX.'
  ]) {
    const requirement = detectToolRequirement({ userText, hasUploads: true });
    assert.equal(requirement.required, true, userText);
    assert.equal(requirement.expectsOutput, true, userText);
  }
});

test('recognizes provider tool errors for the runtime fallback', () => {
  assert.equal(isUnsupportedToolError(new Error('No endpoints found that support tool use.')), true);
  assert.equal(isUnsupportedToolError(new Error('Rate limit exceeded')), false);
});

test('detects vision from input modalities and image generation from output', () => {
  const gpt = deriveModelCapabilities({
    id: 'openai/gpt-4o',
    supported_parameters: ['tools', 'temperature'],
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }
  });
  assert.equal(gpt.vision, true);   // aceita imagem na ENTRADA
  assert.equal(gpt.image, false);   // não GERA imagem
  assert.equal(gpt.tools, true);

  const painter = deriveModelCapabilities({
    id: 'x/image-gen',
    architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] }
  });
  assert.equal(painter.vision, false);
  assert.equal(painter.image, true); // GERA imagem
});

test('accepts tool_choice/functions as evidence of tool support', () => {
  const a = deriveModelCapabilities({ id: 'a', supported_parameters: ['tool_choice', 'temperature'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } });
  const b = deriveModelCapabilities({ id: 'b', supported_parameters: ['functions'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } });
  const c = deriveModelCapabilities({ id: 'c', supported_parameters: ['temperature'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } });
  assert.equal(a.tools, true);
  assert.equal(b.tools, true);
  assert.equal(c.tools, false);
});

test('recognizes provider vision errors for the OCR fallback', () => {
  assert.equal(isUnsupportedVisionError(new Error('No endpoints found that support image input.')), true);
  assert.equal(isUnsupportedVisionError(new Error('This model does not support image messages')), true);
  assert.equal(isUnsupportedVisionError(new Error('Rate limit exceeded')), false);
});
