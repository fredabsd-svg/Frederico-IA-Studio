import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichProviderCatalog, fetchProviderBalance, importProviderCatalog, normalizeBaseURL, assertProviderUrlAllowed, sanitizeUpstreamDetail } from './providerCatalog.js';
import { registerModelCatalog } from './modelCapabilities.js';

// DNS falso e determinístico: os testes não dependem de rede. Todo nome
// resolve para um IP público de documentação, exceto os que o teste de SSRF
// define explicitamente.
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('imports only the catalog returned after an authenticated provider request', async () => {
  let request;
  const result = await importProviderCatalog({
    resolveImpl: publicDns,
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
    resolveImpl: publicDns,
    apiKey: 'bad', baseURL: 'https://api.example.com/v1',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid' } }) })
  }), /recusada/);
  await assert.rejects(() => importProviderCatalog({
    resolveImpl: publicDns,
    apiKey: 'valid', baseURL: 'https://api.example.com/v1',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) })
  }), /nenhum modelo/);
});

test('provider without GET /models imports only the explicitly validated model', async () => {
  let calledWith;
  const result = await importProviderCatalog({
    resolveImpl: publicDns,
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
    resolveImpl: publicDns,
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
    resolveImpl: publicDns,
    apiKey: 'key', providerType: 'openrouter',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { total_credits: 20, total_usage: 3.5 } }) })
  });
  assert.equal(openrouter.balance, 16.5);
  const deepseek = await fetchProviderBalance({
    resolveImpl: publicDns,
    apiKey: 'key', providerType: 'deepseek',
    fetchImpl: async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '8.25' }] }) })
  });
  assert.equal(deepseek.balance, 8.25);
  assert.deepEqual(await fetchProviderBalance({ apiKey: 'key', providerType: 'groq' }), { available: false, reason: 'unsupported' });
});

test('Alibaba unpurchased access is not mislabeled as an invalid key', async () => {
  await assert.rejects(() => importProviderCatalog({
    resolveImpl: publicDns,
    apiKey: 'valid-key', providerType: 'alibaba', modelHint: 'qwen3.7-plus',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    clientFactory: () => ({ chat: { completions: { create: async () => {
      const error = new Error('AccessDenied.Unpurchased: Model service has not been activated');
      error.status = 403;
      throw error;
    } } } })
  }), /chave foi reconhecida.*não está habilitado\/comprado/i);
});

// ---- SSRF da URL base (Regra 6.4) --------------------------------------------
// A URL base de um provedor "OpenAI compatível" é digitada pelo usuário e o
// BACKEND faz requisições autenticadas a ela. Sem guarda, qualquer conta
// apontava para 169.254.169.254, postgres:5432 ou o docker-guard e usava a
// mensagem de erro como oráculo da rede interna.

function neverFetch() {
  return async () => { throw new Error('a requisição NÃO deveria ter saído'); };
}

test('SSRF: IP literal interno é recusado ANTES de qualquer requisição', async () => {
  for (const base of ['http://127.0.0.1:11434/v1', 'http://10.0.0.5/v1', 'http://192.168.0.10/v1', 'http://[::1]:8080/v1', 'http://169.254.169.254/latest', 'http://[::ffff:127.0.0.1]/v1', 'http://localhost:8000/v1', 'http://postgres.internal/v1']) {
    await assert.rejects(() => importProviderCatalog({
      apiKey: 'k', baseURL: base, resolveImpl: publicDns, fetchImpl: neverFetch(), modelHint: 'x',
      clientFactory: () => { throw new Error('o SDK NÃO deveria ter sido criado'); }
    }), /endereço interno ou local/, `deveria recusar ${base}`);
  }
});

test('SSRF: nome público que RESOLVE para rede interna é recusado (anti-DNS-rebinding)', async () => {
  const rebinding = async () => [{ address: '203.0.113.9', family: 4 }, { address: '10.1.2.3', family: 4 }];
  await assert.rejects(() => importProviderCatalog({
    apiKey: 'k', baseURL: 'https://api.parece-publica.example/v1', resolveImpl: rebinding, fetchImpl: neverFetch()
  }), /endereço interno ou local/);
  // Nome que não resolve: falha fechada, sem requisição.
  await assert.rejects(() => importProviderCatalog({
    apiKey: 'k', baseURL: 'https://nao-existe.example/v1', resolveImpl: async () => { throw new Error('ENOTFOUND'); }, fetchImpl: neverFetch()
  }), /Não foi possível resolver/);
});

test('SSRF: saldo do provedor passa pela mesma guarda', async () => {
  const r = await fetchProviderBalance({ apiKey: 'k', providerType: 'openrouter', baseURL: 'http://169.254.169.254/v1', resolveImpl: publicDns, fetchImpl: neverFetch() });
  assert.equal(r.available, false);
  assert.match(r.error, /endereço interno ou local/);
});

test('SSRF: redirecionamento NÃO é seguido nem cai no fallback de validação por chat', async () => {
  let options;
  await assert.rejects(() => importProviderCatalog({
    apiKey: 'k', baseURL: 'https://api.publica.example/v1', resolveImpl: publicDns, modelHint: 'modelo',
    fetchImpl: async (_url, opts) => { options = opts; return { ok: false, status: 302, headers: { get: () => 'http://169.254.169.254/' }, json: async () => ({}) }; },
    clientFactory: () => { throw new Error('o SDK segue redirecionamentos — não pode ser usado aqui'); }
  }), /redirecionamento/);
  assert.equal(options.redirect, 'manual');
});

test('opt-in PROVIDER_ALLOW_PRIVATE_URLS libera endpoint LOCAL, mas nunca metadados de nuvem', async () => {
  const prev = process.env.PROVIDER_ALLOW_PRIVATE_URLS;
  process.env.PROVIDER_ALLOW_PRIVATE_URLS = 'true';
  try {
    await assertProviderUrlAllowed('http://127.0.0.1:11434/v1');
    await assertProviderUrlAllowed('http://ollama:11434/v1', { resolveImpl: async () => [{ address: '172.18.0.4' }] });
    const result = await importProviderCatalog({
      apiKey: 'k', baseURL: 'http://127.0.0.1:11434/v1',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'llama3' }] }) })
    });
    assert.deepEqual(result.models.map(m => m.id), ['llama3']);
    await assert.rejects(() => assertProviderUrlAllowed('http://169.254.169.254/v1'), /endereço interno/);
    await assert.rejects(() => assertProviderUrlAllowed('http://metadata.example/v1', { resolveImpl: async () => [{ address: '169.254.169.254' }] }), /endereço interno/);
    await assert.rejects(() => assertProviderUrlAllowed('http://[fe80::1]/v1'), /endereço interno/);
  } finally {
    if (prev === undefined) delete process.env.PROVIDER_ALLOW_PRIVATE_URLS; else process.env.PROVIDER_ALLOW_PRIVATE_URLS = prev;
  }
});

test('corpo de erro do provedor não é ecoado cru: curto, sem tags nem quebras', async () => {
  const hostil = `<html><body><h1>Internal</h1>\n${'SEGREDO-INTERNO '.repeat(100)}</body></html>`;
  let error;
  try {
    await importProviderCatalog({
      apiKey: 'k', baseURL: 'https://api.publica.example/v1', resolveImpl: publicDns, allowModelValidation: false,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: hostil } }) })
    });
  } catch (err) { error = err; }
  assert.ok(error);
  assert.doesNotMatch(error.message, /<|>|\n/);
  assert.ok(error.message.length <= 220, `mensagem longa demais: ${error.message.length}`);
  assert.equal(sanitizeUpstreamDetail('a\u0000b\r\nc <script>x</script>'), 'a b c x');
});
