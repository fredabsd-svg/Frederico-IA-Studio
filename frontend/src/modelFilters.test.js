import test from 'node:test';
import assert from 'node:assert/strict';
import { filterModels } from './modelFilters.js';

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
