import { EyeOff } from 'lucide-react';
import React from 'react';
import { COMPANION_CONTROL_MODES, settingsForCompanionMode } from './companionMode.js';

/** Botão no avatar que oculta o Nino (enabled: false). Não apaga o código do Companion. */
export function CompanionHideButton({ companion, settings, characterName }) {
  return (
    <button
      type="button"
      className="cmpHideBtn"
      title={`Ocultar ${characterName}`}
      aria-label={`Ocultar ${characterName}`}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        companion.saveSettings(settingsForCompanionMode(COMPANION_CONTROL_MODES.OFF, settings));
      }}
    >
      <EyeOff size={12} /> Ocultar
    </button>
  );
}
