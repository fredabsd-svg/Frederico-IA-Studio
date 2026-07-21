import assert from 'node:assert/strict';
import test from 'node:test';

// A decisão de suportar prompt caching depende do DEEPSEEK_BASE_URL, lido no
// import do módulo. Testamos os dois cenários com imports isolados por query
// string (o loader de ES modules cacheia por URL).
test('DeepSeek direto: NÃO aplica cache_control', async () => {
  process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
  const { applyPromptCache, providerSupportsPromptCache } = await import('./provider.js?direct');
  assert.equal(providerSupportsPromptCache('anthropic/claude-3.5-sonnet'), false);
  const msgs = [{ role: 'system', content: 'base' }, { role: 'user', content: 'oi' }];
  applyPromptCache(msgs, 'anthropic/claude-3.5-sonnet', 1);
  assert.equal(typeof msgs[0].content, 'string'); // intocado
});

test('OpenRouter + Anthropic: marca o prefixo estável com cache_control', async () => {
  process.env.DEEPSEEK_BASE_URL = 'https://openrouter.ai/api/v1';
  const { applyPromptCache, providerSupportsPromptCache } = await import('./provider.js?or');
  assert.equal(providerSupportsPromptCache('anthropic/claude-3.5-sonnet'), true);
  assert.equal(providerSupportsPromptCache('deepseek/deepseek-chat'), false); // fora das famílias suportadas
  const msgs = [
    { role: 'system', content: 'prompt-base' },
    { role: 'system', content: 'nota de ferramentas' },
    { role: 'system', content: 'memória do turno' },
    { role: 'user', content: 'oi' }
  ];
  applyPromptCache(msgs, 'anthropic/claude-3.5-sonnet', 2); // estático = índices 0 e 1
  // breakpoint 1: system[0]
  assert.ok(Array.isArray(msgs[0].content));
  assert.equal(msgs[0].content[0].cache_control.type, 'ephemeral');
  // breakpoint 2: fim do preâmbulo estático (índice 1)
  assert.ok(Array.isArray(msgs[1].content));
  // dinâmico (memória) e user NÃO são marcados
  assert.equal(typeof msgs[2].content, 'string');
  assert.equal(typeof msgs[3].content, 'string');
});

test('OpenRouter + modelo não suportado: no-op', async () => {
  process.env.DEEPSEEK_BASE_URL = 'https://openrouter.ai/api/v1';
  const { applyPromptCache } = await import('./provider.js?or2');
  const msgs = [{ role: 'system', content: 'base' }, { role: 'user', content: 'oi' }];
  applyPromptCache(msgs, 'meta-llama/llama-3.1-8b', 1);
  assert.equal(typeof msgs[0].content, 'string');
});

test('addUsage soma cached_tokens de prompt_tokens_details', async () => {
  const { addUsage } = await import('./provider.js?usage');
  const acc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
  addUsage(acc, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 80 } });
  assert.equal(acc.cached_tokens, 80);
  addUsage(acc, { prompt_tokens: 50, cached_tokens: 20 }); // formato alternativo
  assert.equal(acc.cached_tokens, 100);
});
