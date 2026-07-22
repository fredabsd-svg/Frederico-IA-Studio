import test from 'node:test';
import assert from 'node:assert/strict';
import { filterModels, tierOf, matchesModality } from './modelFilters.js';

const models = [
  { id: 'p1::vision', providerId: 'p1', providerName: 'A', providerModelId: 'acme/vision', family: 'acme', capabilities: { tools: true, vision: true }, context: 100000, pricingKnown: true, price: 0.000001 },
  { id: 'p2::unknown', providerId: 'p2', providerName: 'B', providerModelId: 'beta/unknown', family: 'beta', capabilities: { tools: null, vision: null }, context: 0, pricingKnown: false },
  { id: 'p1::free', providerId: 'p1', providerName: 'A', providerModelId: 'acme/free:free', family: 'acme', capabilities: { tools: false }, free: true, pricingKnown: true }
];

test('combines provider, family, context and capability filters', () => {
  assert.deepEqual(filterModels(models, { provider: 'p1', family: 'acme', context: '100k', flags: ['tools'] }).map(m => m.id), ['p1::vision']);
});

test('unknown capability never passes a positive capability filter', () => {
  assert.deepEqual(filterModels(models, { flags: ['tools'] }).map(m => m.id), ['p1::vision']);
});

test('distinguishes free, paid and unknown pricing', () => {
  assert.deepEqual(filterModels(models, { price: 'free' }).map(m => m.id), ['p1::free']);
  assert.deepEqual(filterModels(models, { price: 'paid' }).map(m => m.id), ['p1::vision']);
  assert.deepEqual(filterModels(models, { price: 'known' }).map(m => m.id), ['p1::vision', 'p1::free']);
});

test('filtro por classificação usa o tier do backend', () => {
  const ranked = [
    { id: 'a', name: 'A', tier: 'S+', tierRank: 6, capabilities: { tools: true, vision: true } },
    { id: 'b', name: 'B', tier: 'A', tierRank: 3, capabilities: { tools: true } },
    { id: 'c', name: 'C', capabilities: { tools: true } } // sem selo
  ];
  assert.equal(tierOf(ranked[0]), 'S+');
  assert.deepEqual(filterModels(ranked, { tier: 'S' }).map(m => m.id), ['a'], 'S ou acima → só o S+');
  assert.deepEqual(filterModels(ranked, { tier: 'A' }).map(m => m.id), ['a', 'b']);
  assert.deepEqual(filterModels(ranked, { tier: 'B+' }).map(m => m.id), ['a', 'b'], 'sem selo fica de fora');
});

test('filtro por modalidade separa multimodal, texto e geração', () => {
  const mm = [
    { id: 'txt', capabilities: { text: true, tools: true } },
    { id: 'vis', capabilities: { text: true, vision: true } },
    { id: 'img', capabilities: { text: true, image: true } }
  ];
  assert.deepEqual(filterModels(mm, { modality: 'multimodal' }).map(m => m.id), ['vis']);
  assert.deepEqual(filterModels(mm, { modality: 'text' }).map(m => m.id), ['txt']);
  assert.deepEqual(filterModels(mm, { modality: 'image' }).map(m => m.id), ['img']);
  assert.equal(matchesModality(mm[1], 'vision'), true);
});
