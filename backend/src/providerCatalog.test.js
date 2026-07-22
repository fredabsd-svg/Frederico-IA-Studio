import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichProviderCatalog, fetchProviderBalance, importProviderCatalog, normalizeBaseURL } from './providerCatalog.js';
import { registerModelCatalog } from './modelCapabilities.js';

test('imports only the catalog returned after an authenticated provider request', async () => {
  let request;
  const result = await importProviderCatalog({
    apiKey: 'secret', providerType: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1/',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ data: [{ id: 'nvidia/model-a' }, { id: 'nvidia/model-a' }, { id: 'meta/model-b' }] }) };
    }
  });
  assert.equal(request.url, 'https://integrate.api.nvidia.com/v1/models');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(result.models.map(model => model.id), ['nvidia/model-a', 'meta/model-b']);
});

test('rejects invalid keys and empty catalogs instead of exposing fallback models', async () => {
  await assert.rejects(() => importProviderCatalog({
    apiKey: 'bad', baseURL: 'https://api.example.com/v1',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid' } }) })
  }), /recusada/);
  await assert.rejects(() => importProviderCatalog({
    apiKey: 'valid', baseURL: 'https://api.example.com/v1',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) })
  }), /nenhum modelo/);
});

test('provider without GET /models imports only the explicitly validated model', async () => {
  let calledWith;
  const result = await importProviderCatalog({
    apiKey: 'alibaba-key', providerType: 'alibaba', modelHint: 'qwen3.7-plus',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    clientFactory: options => ({
      chat: { completions: { create: async request => { calledWith = { options, request }; return { choices: [{ message: { content: 'OK' } }] }; } } }
    })
  });
  assert.equal(calledWith.options.baseURL, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  assert.equal(calledWith.request.model, 'qwen3.7-plus');
  assert.deepEqual(result.models, [{ id: 'qwen3.7-plus', name: 'qwen3.7-plus' }]);
  assert.equal(result.validation, 'model');
});

test('provider base URLs are normalized and unsafe URL shapes are rejected', () => {
  assert.equal(normalizeBaseURL('', 'deepseek'), 'https://api.deepseek.com');
  assert.throws(() => normalizeBaseURL('ftp://example.com/v1'), /HTTP\/HTTPS/);
  assert.throws(() => normalizeBaseURL('https://user:pass@example.com/v1'), /credenciais/);
  assert.equal(
    normalizeBaseURL('https://workspace.us-east-1.maas.aliyuncs.com/compatible-mode/v1', 'alibaba'),
    'https://workspace.us-east-1.maas.aliyuncs.com/compatible-mode/v1'
  );
  assert.throws(
    () => normalizeBaseURL('https://example.com/compatible-mode/v1', 'alibaba'),
    /oficial do Alibaba/
  );
});

test('enriches DeepSeek V4 models with official names, capabilities, context and prices', async () => {
  const result = await importProviderCatalog({
    apiKey: 'deepseek-key', providerType: 'deepseek',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] })
    })
  });

  const [flash, pro] = result.models;
  assert.equal(flash.name, 'DeepSeek V4 Flash');
  assert.equal(pro.name, 'DeepSeek V4 Pro');
  assert.equal(flash.context_length, 1_000_000);
  const [profile] = registerModelCatalog([flash], {
    providerId: 'deepseek-key-id', providerName: 'DeepSeek', providerType: 'deepseek'
  });
  assert.deepEqual(profile.capabilities, {
    text: true, tools: true, vision: false, image: false, reasoning: true, video: false,
    audio: false, web: false, files: false, code: false, embeddings: false
  });
  assert.equal(flash.pricing.prompt * 1_000_000, 0.14);
  assert.equal(flash.pricing.completion * 1_000_000, 0.28);
  assert.equal(pro.pricing.prompt * 1_000_000, 0.435);
  assert.equal(pro.pricing.completion * 1_000_000, 0.87);
});

test('enriches an existing DeepSeek catalog without requiring a key refresh', () => {
  const [model] = enrichProviderCatalog([{ id: 'deepseek-v4-flash' }], 'deepseek');
  assert.equal(model.name, 'DeepSeek V4 Flash');
  assert.equal(model.context_length, 1_000_000);
  assert.deepEqual(model.architecture.input_modalities, ['text']);
  assert.equal(model.supported_parameters.includes('tools'), true);
});

test('normalizes rich metadata published by different provider APIs', () => {
  const [model] = enrichProviderCatalog([{
    id: 'acme/vision', display_name: 'Acme Vision', owned_by: 'acme',
    context_window: 131072, max_completion_tokens: 8192,
    input_modalities: ['text', 'image'], output_modalities: ['text'],
    capabilities: { function_calling: true }, input_price: 0.000001, output_price: 0.000002,
    tokens_per_second: 250, active: true
  }], 'custom');
  assert.equal(model.name, 'Acme Vision');
  assert.equal(model.context_length, 131072);
  assert.equal(model.max_output_tokens, 8192);
  assert.deepEqual(model.architecture.input_modalities, ['text', 'image']);
  assert.equal(model.capabilities.tools, true);
  assert.equal(model.pricing.completion, 0.000002);
  assert.equal(model.speed, 250);
});

test('reads official OpenRouter and DeepSeek balances without inventing values', async () => {
  const openrouter = await fetchProviderBalance({
    apiKey: 'key', providerType: 'openrouter',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { total_credits: 20, total_usage: 3.5 } }) })
  });
  assert.equal(openrouter.balance, 16.5);
  const deepseek = await fetchProviderBalance({
    apiKey: 'key', providerType: 'deepseek',
    fetchImpl: async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '8.25' }] }) })
  });
  assert.equal(deepseek.balance, 8.25);
  assert.deepEqual(await fetchProviderBalance({ apiKey: 'key', providerType: 'groq' }), { available: false, reason: 'unsupported' });
});

test('Alibaba unpurchased access is not mislabeled as an invalid key', async () => {
  await assert.rejects(() => importProviderCatalog({
    apiKey: 'valid-key', providerType: 'alibaba', modelHint: 'qwen3.7-plus',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    clientFactory: () => ({ chat: { completions: { create: async () => {
      const error = new Error('AccessDenied.Unpurchased: Model service has not been activated');
      error.status = 403;
      throw error;
    } } } })
  }), /chave foi reconhecida.*não está habilitado\/comprado/i);
});
