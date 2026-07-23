import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeSettings, COMPANION_DEFAULTS } from './companion.js';

// A configuração do Companion nunca confia no cliente: sanitizeSettings preenche
// os padrões, restringe a listas válidas e limita o nível de permissão a 1..5.

test('preenche com os padrões quando o corpo vem vazio', () => {
  assert.deepEqual(sanitizeSettings({}), { ...COMPANION_DEFAULTS });
});

test('mantém apenas modos válidos (cai no padrão quando inválido)', () => {
  assert.equal(sanitizeSettings({ mode: 'proativo' }).mode, 'proativo');
  assert.equal(sanitizeSettings({ mode: 'hackerman' }).mode, COMPANION_DEFAULTS.mode);
});

test('trava o nível de permissão entre 1 e 5', () => {
  assert.equal(sanitizeSettings({ permissionLevel: 99 }).permissionLevel, 5);
  assert.equal(sanitizeSettings({ permissionLevel: -3 }).permissionLevel, 1);
  assert.equal(sanitizeSettings({ permissionLevel: 3 }).permissionLevel, 3);
  assert.equal(sanitizeSettings({ permissionLevel: 'abc' }).permissionLevel, COMPANION_DEFAULTS.permissionLevel);
});

test('normaliza o nome do personagem e limita o tamanho', () => {
  assert.equal(sanitizeSettings({ characterName: '  Pixel  ' }).characterName, 'Pixel');
  assert.equal(sanitizeSettings({ characterName: '' }).characterName, COMPANION_DEFAULTS.characterName);
  assert.equal(sanitizeSettings({ characterName: 'x'.repeat(200) }).characterName.length, 40);
});

test('coage os campos booleanos e restringe o nível de animação', () => {
  const s = sanitizeSettings({ enabled: 0, voice: 1, proactiveAlerts: '', animationLevel: 'turbo' });
  assert.equal(s.enabled, false);
  assert.equal(s.voice, true);
  assert.equal(s.proactiveAlerts, false);
  assert.equal(s.animationLevel, COMPANION_DEFAULTS.animationLevel);
});

test('mantém assistantId nulo quando ausente e string quando presente', () => {
  assert.equal(sanitizeSettings({}).assistantId, null);
  assert.equal(sanitizeSettings({ assistantId: 'abc123' }).assistantId, 'abc123');
});
