// `apiJson`: a resposta de erro do backend nunca pode virar aviso de sucesso.
//
// O defeito que motivou: "Rotina disparada agora" e "Modo gratuito ativado!"
// apareciam com o backend respondendo 4xx/5xx, porque o painel não olhava
// `res.ok`. Estes testes travam o contrato do atalho que substituiu isso.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apiJson, apiErrorMessage } from './apiJson.js';

const resposta = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body))
});

test('2xx devolve o JSON do corpo', async () => {
  const data = await apiJson('/api/x', {}, async () => resposta(200, { ok: true, n: 3 }));
  assert.deepEqual(data, { ok: true, n: 3 });
});

test('2xx sem corpo devolve null em vez de explodir', async () => {
  assert.equal(await apiJson('/api/x', {}, async () => resposta(204)), null);
});

test('4xx/5xx lança com a mensagem do backend e o status', async () => {
  await assert.rejects(
    apiJson('/api/x', {}, async () => resposta(409, { error: 'Rotina já está rodando.' })),
    err => err.message === 'Rotina já está rodando.' && err.status === 409
  );
});

test('erro sem mensagem do backend (ou corpo HTML) vira "HTTP <status>"', async () => {
  await assert.rejects(apiJson('/api/x', {}, async () => resposta(502, '<html>Bad Gateway</html>')), /HTTP 502/);
  await assert.rejects(apiJson('/api/x', {}, async () => resposta(500, { error: '   ' })), /HTTP 500/);
});

test('objeto no body vira JSON com Content-Type', async () => {
  let recebido;
  await apiJson('/api/x', { method: 'POST', body: { a: 1 } }, async (url, init) => { recebido = init; return resposta(200, {}); });
  assert.equal(recebido.body, '{"a":1}');
  assert.equal(recebido.headers['Content-Type'], 'application/json');
});

test('string no body passa intacta', async () => {
  let recebido;
  await apiJson('/api/x', { method: 'PUT', body: '{"b":2}', headers: { 'Content-Type': 'application/json' } }, async (url, init) => { recebido = init; return resposta(200, {}); });
  assert.equal(recebido.body, '{"b":2}');
});

test('queda de rede é propagada (não vira sucesso silencioso)', async () => {
  await assert.rejects(apiJson('/api/x', {}, async () => { throw new TypeError('Failed to fetch'); }), /Failed to fetch/);
});

test('apiErrorMessage traduz a queda de rede e prefixa o contexto', () => {
  assert.equal(apiErrorMessage(new TypeError('Failed to fetch'), 'Não foi possível disparar a rotina'), 'Não foi possível disparar a rotina: sem conexão com o servidor');
  assert.equal(apiErrorMessage(new Error('HTTP 500'), 'Falhou'), 'Falhou: HTTP 500');
  assert.equal(apiErrorMessage(new Error(''), 'Falhou'), 'Falhou');
  assert.equal(apiErrorMessage(null), 'Algo deu errado.');
});
