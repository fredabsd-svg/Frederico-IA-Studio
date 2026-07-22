import test from 'node:test';
import assert from 'node:assert/strict';
import { importProviderCatalog, normalizeBaseURL } from './providerCatalog.js';

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
});
