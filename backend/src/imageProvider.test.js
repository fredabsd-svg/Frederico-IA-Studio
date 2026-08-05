import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogImageModels, chooseImageProvider, imageModelFor, PREFERRED_IMAGE_MODELS } from './imageProvider.js';

// Catálogo no formato que o app importa do provedor (OpenRouter publica
// `architecture.output_modalities`).
const openrouter = {
  id: 'or-1',
  providerType: 'openrouter',
  providerName: 'OpenRouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-x',
  hasKey: true,
  models: [
    { id: 'deepseek/deepseek-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'google/gemini-2.5-flash-image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] } }
  ]
};

const deepseek = {
  id: 'ds-1',
  providerType: 'deepseek',
  providerName: 'DeepSeek',
  baseURL: 'https://api.deepseek.com',
  apiKey: 'sk-ds-x',
  hasKey: true,
  models: [{ id: 'deepseek-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }]
};

test('só entra na lista quem gera imagem na SAÍDA — aceitar imagem na entrada é visão', () => {
  assert.deepEqual(catalogImageModels(openrouter), ['google/gemini-2.5-flash-image']);
  assert.deepEqual(catalogImageModels(deepseek), []);
  // Modelo com visão (imagem na entrada) e texto na saída não gera imagem.
  assert.deepEqual(catalogImageModels({
    models: [{ id: 'x/vision-only', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }]
  }), []);
});

// A regressão que originou este módulo: numa conta com DeepSeek (mais antiga) e
// OpenRouter, a imagem era pedida à DeepSeek — base sem geração de imagem — ou
// morria em "nenhuma chave configurada" com o chat funcionando na mesma tela.
test('escolhe a chave que gera imagem, não a mais antiga da conta', () => {
  const escolha = chooseImageProvider([deepseek, openrouter], { activeId: 'ds-1' });
  assert.equal(escolha.provider.id, 'or-1');
  assert.equal(escolha.model, 'google/gemini-2.5-flash-image');
});

test('com mais de uma chave capaz, vence a do modelo ativo na conversa', () => {
  const outro = { ...openrouter, id: 'or-2', providerName: 'OpenRouter (pessoal)' };
  assert.equal(chooseImageProvider([openrouter, outro], { activeId: 'or-2' }).provider.id, 'or-2');
  assert.equal(chooseImageProvider([openrouter, outro], { activeId: 'or-1' }).provider.id, 'or-1');
  // Sem provedor ativo identificável, mantém a ordem de cadastro.
  assert.equal(chooseImageProvider([openrouter, outro], {}).provider.id, 'or-1');
});

test('nenhuma chave capaz devolve null — quem chama distingue a causa do erro', () => {
  assert.equal(chooseImageProvider([deepseek], { activeId: 'ds-1' }), null);
  assert.equal(chooseImageProvider([], {}), null);
});

test('IMAGE_MODEL do operador manda, mas não em provedor que não o tem', () => {
  const outro = { ...openrouter, models: [...openrouter.models, { id: 'x/outra-imagem', architecture: { output_modalities: ['image'] } }] };
  assert.equal(imageModelFor(outro, 'x/outra-imagem'), 'x/outra-imagem');
  // O modelo imposto não existe no catálogo deste provedor: não usamos —
  // seria um 404 disfarçado de configuração.
  assert.equal(imageModelFor(deepseek, 'x/outra-imagem'), '');
  assert.equal(imageModelFor(openrouter, 'x/outra-imagem'), '');
  // Exceção: provedor OpenRouter sem catálogo publicado (endpoint sem
  // GET /models, validado por modelo único) aceita a imposição.
  assert.equal(imageModelFor({ providerType: 'openrouter', models: [] }, 'x/outra-imagem'), 'x/outra-imagem');
  assert.equal(imageModelFor({ providerType: 'custom', models: [] }, 'x/outra-imagem'), '');
});

test('sem IMAGE_MODEL, a preferência conhecida vem antes de qualquer modelo de imagem do catálogo', () => {
  const provider = {
    providerType: 'openrouter',
    models: [
      { id: 'z/imagem-obscura', architecture: { output_modalities: ['image'] } },
      { id: PREFERRED_IMAGE_MODELS[0], architecture: { output_modalities: ['text', 'image'] } }
    ]
  };
  assert.equal(imageModelFor(provider), PREFERRED_IMAGE_MODELS[0]);
  // Catálogo sem nenhuma preferida: usa o que houver, em vez de recusar.
  assert.equal(imageModelFor({ providerType: 'openrouter', models: [provider.models[0]] }), 'z/imagem-obscura');
});
