import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantModelRef, matchModel, modelNotices, multiModelStatus, modelDisplayName, rawModelId, resolveModelChoice } from './modelChoice.js';

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

test('modelNotices: resposta normal não ganha selo', () => {
  assert.deepEqual(modelNotices(null), []);
  assert.deepEqual(modelNotices({ state: 'completed', model: 'p1::deepseek-chat' }, MODELS), []);
});

test('modelNotices: troca do modo gratuito diz o modelo real e o motivo', () => {
  const [n] = modelNotices({ modelSwap: { from: 'p2::gpt-5', to: 'p1::deepseek-chat', reason: 'free_allowlist' } }, MODELS);
  assert.equal(n.kind, 'gratuito');
  assert.equal(n.label, 'Modo gratuito · DeepSeek Chat');
  assert.match(n.detail, /GPT-5 não está entre os modelos do modo gratuito/);
  const [k] = modelNotices({ modelSwap: { from: 'p2::gpt-5', to: 'free::x', reason: 'provider_key_unavailable' }, providerFallback: { reason: 'provider_key_unavailable' } }, MODELS);
  assert.match(k.detail, /chave do provedor de GPT-5 não pôde ser lida/);
  assert.equal(k.label, 'Modo gratuito · x', 'modelo fora do catálogo mostra o id cru, nunca a referência interna');
});

test('modelNotices: fallback de provedor sem troca de modelo usa a mensagem do backend', () => {
  const [n] = modelNotices({ providerFallback: { reason: 'provider_key_unavailable', message: 'Sua chave falhou; usei a da plataforma.' } });
  assert.deepEqual(n, { kind: 'gratuito', label: 'Modo gratuito', detail: 'Sua chave falhou; usei a da plataforma.' });
});

test('modelNotices: modelo de reserva no meio da execução', () => {
  const notices = modelNotices({ modelFailover: { from: 'p2::gpt-5', to: 'p1::deepseek-chat' } }, MODELS);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'reserva');
  assert.equal(notices[0].label, 'Modelo de reserva · DeepSeek Chat');
  assert.match(notices[0].detail, /GPT-5 ficou indisponível/);
});

test('modelNotices: troca gratuita e reserva na mesma resposta viram dois selos', () => {
  const notices = modelNotices({
    modelSwap: { from: 'p2::gpt-5', to: 'p1::deepseek-chat', reason: 'free_allowlist' },
    modelFailover: { from: 'p1::deepseek-chat', to: 'p2::texto-puro' }
  }, MODELS);
  assert.deepEqual(notices.map(n => n.kind), ['gratuito', 'reserva']);
});
