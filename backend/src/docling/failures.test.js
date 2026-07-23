import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailure } from './failures.js';

test('detecta documento protegido por senha (sem retry)', () => {
  const f = classifyFailure('documento protegido por senha (password/encrypted)');
  assert.equal(f.kind, 'protegido');
  assert.equal(f.canRetry, false);
  assert.match(f.suggestion, /senha/i);
});

test('detecta timeout (com retry)', () => {
  const f = classifyFailure('Timeout no docling-service.');
  assert.equal(f.kind, 'timeout');
  assert.equal(f.canRetry, true);
});

test('detecta serviço indisponível', () => {
  assert.equal(classifyFailure('docling-service /jobs HTTP 503').kind, 'servico_indisponivel');
  assert.equal(classifyFailure('fetch failed').kind, 'servico_indisponivel');
});

test('detecta arquivo corrompido', () => {
  assert.equal(classifyFailure('unexpected EOF while reading pdf').kind, 'corrompido');
});

test('detecta formato não suportado (sem retry)', () => {
  const f = classifyFailure('unsupported file format');
  assert.equal(f.kind, 'formato_nao_suportado');
  assert.equal(f.canRetry, false);
});

test('detecta falha de OCR e cancelamento', () => {
  assert.equal(classifyFailure('tesseract falhou').kind, 'ocr_falhou');
  assert.equal(classifyFailure('Processamento cancelado.').kind, 'cancelado');
});

test('mensagem desconhecida cai no genérico com retry', () => {
  const f = classifyFailure('algo estranho aconteceu xyz');
  assert.equal(f.kind, 'desconhecido');
  assert.equal(f.canRetry, true);
  assert.ok(f.label && f.suggestion);
});
