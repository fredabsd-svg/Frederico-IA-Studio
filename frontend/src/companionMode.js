export const COMPANION_CONTROL_MODES = Object.freeze({
  ACTIVE: 'active',
  SILENT: 'silent',
  OFF: 'off',
});

export function companionControlMode(settings = {}) {
  if (!settings.enabled) return COMPANION_CONTROL_MODES.OFF;
  if (settings.mode === 'silencioso') return COMPANION_CONTROL_MODES.SILENT;
  return COMPANION_CONTROL_MODES.ACTIVE;
}

export function settingsForCompanionMode(nextMode, current = {}) {
  if (nextMode === COMPANION_CONTROL_MODES.OFF) return { enabled: false };
  if (nextMode === COMPANION_CONTROL_MODES.SILENT) {
    return {
      enabled: true,
      mode: 'silencioso',
      animationLevel: 'nenhum',
      proactiveAlerts: false,
      proactiveWriting: false,
      voice: false,
    };
  }
  return {
    enabled: true,
    mode: ['auxiliar', 'proativo'].includes(current.mode) ? current.mode : 'auxiliar',
    animationLevel: current.animationLevel === 'nenhum' ? 'reduzido' : (current.animationLevel || 'completo'),
    proactiveAlerts: true,
    proactiveWriting: true,
  };
}
