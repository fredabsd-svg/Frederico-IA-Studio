import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/tmp/frederico-catalogsync-tests';

const { mergePreserving, diffCatalog } = await import('./catalogSync.js');

test('mergePreserving não apaga dado bom com vazio da API', () => {
  const old = [{
    id: 'acme/x', name: 'Modelo X', context_length: 128000,
    max_output_tokens: 8000, pricing: { prompt: 0.000001, completion: 0.000002 },
    architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools']
  }];
  // A API volta pobre (só o id) numa atualização: deve herdar tudo do anterior.
  const fresh = [{ id: 'acme/x' }];
  const [m] = mergePreserving(old, fresh);
  assert.equal(m.name, 'Modelo X');
  assert.equal(m.context_length, 128000);
  assert.equal(m.max_output_tokens, 8000);
  assert.deepEqual(m.pricing, { prompt: 0.000001, completion: 0.000002 });
  assert.deepEqual(m.architecture.input_modalities, ['text', 'image']);
  assert.deepEqual(m.supported_parameters, ['tools']);
});

test('mergePreserving mantém o dado NOVO quando a API traz atualização', () => {
  const old = [{ id: 'acme/x', name: 'Antigo', context_length: 8000 }];
  const fresh = [{ id: 'acme/x', name: 'Novo', context_length: 256000 }];
  const [m] = mergePreserving(old, fresh);
  assert.equal(m.name, 'Novo');
  assert.equal(m.context_length, 256000);
});

test('mergePreserving deixa modelo inédito intacto', () => {
  const [m] = mergePreserving([], [{ id: 'acme/novo', name: 'Novo' }]);
  assert.equal(m.name, 'Novo');
});

test('diffCatalog detecta adicionados, removidos e alterados', () => {
  const old = [
    { id: 'x', name: 'X', context_length: 8000 },
    { id: 'z', name: 'Z' }                              // será removido
  ];
  const novo = [
    { id: 'x', name: 'X', context_length: 200000, architecture: { input_modalities: ['text', 'image'] } }, // ganhou contexto + visão
    { id: 'y', name: 'Y' }                              // novo
  ];
  const rep = diffCatalog(old, novo, 'custom');
  assert.deepEqual(rep.added.map(a => a.id), ['y']);
  assert.deepEqual(rep.removed.map(r => r.id), ['z']);
  const fields = rep.changed.filter(c => c.id === 'x').map(c => c.field);
  assert.ok(fields.includes('context'), 'detecta mudança de contexto');
  assert.ok(fields.includes('capabilities.vision'), 'detecta ganho de visão');
  const visao = rep.changed.find(c => c.id === 'x' && c.field === 'capabilities.vision');
  assert.equal(visao.to, true);
});

test('diffCatalog aponta duplicados e incompletos', () => {
  const rep = diffCatalog([], [
    { id: 'dup' }, { id: 'dup' },                      // duplicado
    { id: 'sempreco', name: 'Sem preço' }              // sem preço/contexto → incompleto
  ], 'custom');
  assert.deepEqual(rep.duplicates, ['dup'], 'aponta o id duplicado na resposta crua');
  assert.ok(rep.incomplete.some(i => i.id === 'sempreco'));
  // O catálogo deduplica por id na normalização → 'dup' entra uma vez só.
  assert.equal(rep.counts.added, 2);
});
