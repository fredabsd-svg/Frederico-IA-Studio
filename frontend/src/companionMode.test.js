import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_CONTROL_MODES, companionControlMode, settingsForCompanionMode } from './companionMode.js';

test('controle do Nino reconhece ativo, silencioso e desligado', () => {
  assert.equal(companionControlMode({ enabled: true, mode: 'auxiliar' }), COMPANION_CONTROL_MODES.ACTIVE);
  assert.equal(companionControlMode({ enabled: true, mode: 'silencioso' }), COMPANION_CONTROL_MODES.SILENT);
  assert.equal(companionControlMode({ enabled: false, mode: 'proativo' }), COMPANION_CONTROL_MODES.OFF);
});

test('modo silencioso remove animação, voz e iniciativa', () => {
  assert.deepEqual(settingsForCompanionMode(COMPANION_CONTROL_MODES.SILENT, { voice: true }), {
    enabled: true,
    mode: 'silencioso',
    animationLevel: 'nenhum',
    proactiveAlerts: false,
    proactiveWriting: false,
    voice: false,
  });
});

test('reativar restaura comportamento útil sem ligar a voz', () => {
  assert.deepEqual(settingsForCompanionMode(COMPANION_CONTROL_MODES.ACTIVE, {
    mode: 'silencioso', animationLevel: 'nenhum', voice: false,
  }), {
    enabled: true,
    mode: 'auxiliar',
    animationLevel: 'reduzido',
    proactiveAlerts: true,
    proactiveWriting: true,
  });
});
