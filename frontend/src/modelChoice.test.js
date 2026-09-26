import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantModelRef, matchModel, multiModelStatus, modelDisplayName, rawModelId, resolveModelChoice } from './modelChoice.js';

const MODELS = [
  { id: 'p1::deepseek-chat', name: 'DeepSeek Chat', providerModelId: 'deepseek-chat', capabilities: { tools: true } },
  { id: 'p2::gpt-5', name: 'GPT-5', providerModelId: 'gpt-5', capabilities: { tools: true } },
  { id: 'p2::texto-puro', name: 'Texto', providerModelId: 'texto-puro', capabilities: { tools: false } },
  { id: 'p3::gpt-5', name: 'GPT-5 (outro provedor)', providerModelId: 'gpt-5' }
];

test('rawModelId tira o prefixo do provedor', () => {
  assert.equal(rawModelId('p1::deepseek-chat'), 'deepseek-chat');
  assert.equal(rawModelId('deepseek-chat'), 'deepseek-chat');
  assert.equal(rawModelId(''), '');
});

test('matchModel: id exato vence', () => {
  assert.equal(matchModel(MODELS, 'p3::gpt-5').id, 'p3::gpt-5');
});

test('matchModel: id cru legado casa quando só um provedor o oferece', () => {
  assert.equal(matchModel(MODELS, 'deepseek-chat').id, 'p1::deepseek-chat');
});

test('matchModel: id cru ambíguo não adivinha o provedor', () => {
  assert.equal(matchModel(MODELS, 'gpt-5'), null);
});

test('resolveModelChoice mantém a escolha salva quando ela existe', () => {
  assert.deepEqual(resolveModelChoice(MODELS, ['p2::gpt-5', 'p1::deepseek-chat']), { id: 'p2::gpt-5', replaced: false, from: null });
});

test('resolveModelChoice cai para o próximo candidato sem marcar troca', () => {
  const r = resolveModelChoice(MODELS, ['', 'deepseek-chat']);
  assert.equal(r.id, 'p1::deepseek-chat');
  assert.equal(r.replaced, false);
});

test('resolveModelChoice sinaliza a troca quando o modelo pedido sumiu', () => {
  const r = resolveModelChoice(MODELS, ['p9::removido'], { prefer: m => m.capabilities?.tools !== false });
  assert.equal(r.id, 'p1::deepseek-chat');
  assert.equal(r.replaced, true);
  assert.equal(r.from, 'p9::removido');
});

test('resolveModelChoice sem pedido nenhum usa o padrão sem aviso', () => {
  const r = resolveModelChoice(MODELS, [], { prefer: m => m.capabilities?.tools !== false });
  assert.equal(r.id, 'p1::deepseek-chat');
  assert.equal(r.replaced, false);
});

test('resolveModelChoice com catálogo vazio não inventa modelo', () => {
  assert.deepEqual(resolveModelChoice([], ['p1::x']), { id: '', replaced: false, from: 'p1::x' });
});

test('modelDisplayName nunca mostra a referência interna inteira', () => {
  assert.equal(modelDisplayName(MODELS, 'p2::gpt-5'), 'GPT-5');
  assert.equal(modelDisplayName(MODELS, 'p9::removido'), 'removido');
});

test('assistente usa a referência completa (model_ref) antes do id cru', () => {
  assert.equal(assistantModelRef({ model: 'deepseek-chat', model_ref: 'p1::deepseek-chat' }), 'p1::deepseek-chat');
  assert.equal(assistantModelRef({ model: 'deepseek-chat', model_ref: null }), 'deepseek-chat');
  assert.equal(assistantModelRef(null), '');
});

test('multimodelo só fica pronto com 2+ membros que existem no catálogo', () => {
  assert.equal(multiModelStatus({ models: [{ id: 'p1::deepseek-chat' }, { id: 'p2::gpt-5' }] }, MODELS).ready, true);
  const sumiu = multiModelStatus({ models: [{ id: 'p1::deepseek-chat' }, { id: 'p9::removido' }] }, MODELS);
  assert.equal(sumiu.ready, false);
  assert.deepEqual(sumiu.missing, ['p9::removido']);
  assert.equal(multiModelStatus({ models: [{ id: '' }, { id: '' }] }, []).ready, false);
  assert.equal(multiModelStatus({ models: [{ id: 'p1::deepseek-chat' }] }, MODELS).ready, false);
});
