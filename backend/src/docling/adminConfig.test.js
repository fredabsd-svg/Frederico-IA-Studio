import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeOverrides, adminEditable } from './adminConfig.js';

// sanitizeOverrides guarda só chaves editáveis e válidas; ausentes ficam de fora
// (não sobrescrevem o padrão do ambiente sem intenção).

test('mantém apenas chaves presentes e válidas', () => {
  const o = sanitizeOverrides({ ocr: 'always', maxChunkTokens: 900 });
  assert.deepEqual(o, { ocr: 'always', maxChunkTokens: 900 });
  assert.equal('lang' in o, false);
  assert.equal('tables' in o, false);
});

test('OCR inválido cai para auto; idioma é limpo', () => {
  assert.equal(sanitizeOverrides({ ocr: 'xxx' }).ocr, 'auto');
  assert.equal(sanitizeOverrides({ lang: 'por+eng!!' }).lang, 'por+eng');
  assert.equal(sanitizeOverrides({ lang: '@@@' }).lang, 'por');
});

test('trava limites numéricos', () => {
  assert.equal(sanitizeOverrides({ maxChunkTokens: 999999 }).maxChunkTokens, 8000);
  assert.equal(sanitizeOverrides({ maxChunkTokens: 1 }).maxChunkTokens, 200);
  assert.equal(sanitizeOverrides({ maxPages: -5 }).maxPages, 0);
  assert.equal(sanitizeOverrides({ maxPages: 99999 }).maxPages, 5000);
});

test('coage booleanos', () => {
  const o = sanitizeOverrides({ tables: 0, formulas: 1 });
  assert.equal(o.tables, false);
  assert.equal(o.formulas, true);
});

test('adminEditable projeta só os campos do admin', () => {
  const e = adminEditable({ ocr: 'auto', lang: 'por', tables: true, formulas: false, maxPages: 0, maxChunkTokens: 1200, timeoutMs: 999, doclingVersion: 'x' });
  assert.deepEqual(Object.keys(e).sort(), ['formulas', 'lang', 'maxChunkTokens', 'maxPages', 'ocr', 'tables']);
});
