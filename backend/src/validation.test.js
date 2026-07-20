import assert from 'node:assert/strict';
import test from 'node:test';
import { validate, schemas } from './validation.js';

// Executa o middleware contra um body e devolve { status, json, passed }
function run(schema, body) {
  const req = { body };
  let status = null, json = null, passed = false;
  const res = { status(s) { status = s; return this; }, json(j) { json = j; return this; } };
  validate(schema)(req, res, () => { passed = true; });
  return { status, json, passed, body: req.body };
}

test('rejeita mensagem vazia no chat com a mensagem amigável em português', () => {
  const r = run(schemas.chat, { message: '   ' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Mensagem vazia/);
});

test('rejeita mensagem grande demais preservando o texto original do erro', () => {
  const r = run(schemas.chat, { message: 'x'.repeat(100_001) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /grande demais/);
});

test('aceita chat válido e aplica trim na mensagem', () => {
  const r = run(schemas.chat, { message: '  olá  ', webSearch: true });
  assert.equal(r.passed, true);
  assert.equal(r.body.message, 'olá');
  assert.equal(r.body.webSearch, true); // campo desconhecido pelo schema passa adiante (loose)
});

test('campo obrigatório ausente responde 400 com o campo apontado', () => {
  const r = run(schemas.assistantCreate, { name: 'X' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /system_prompt/);
});

test('enum inválido é rejeitado (type da memória)', () => {
  const r = run(schemas.memoryCreate, { content: 'abc', type: 'hack' });
  assert.equal(r.status, 400);
});

test('importance vem como string do frontend e é coagida para número', () => {
  const r = run(schemas.memoryCreate, { content: 'abc', importance: '4' });
  assert.equal(r.passed, true);
  assert.equal(r.body.importance, 4);
});

test('ação de controle fora do enum é rejeitada', () => {
  const r = run(schemas.control, { action: 'kill' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Ação inválida/);
});
