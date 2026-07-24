import React, { useState } from 'react';
import { Modal, ModelPicker } from '../components.jsx';
import { Sparkles, ShieldCheck } from 'lucide-react';

// Configuração do Copiloto/Companion — agora vive em Configurações (não mais na
// engrenagem do avatar). Reúne personagem, persona, modelo, modo de comportamento,
// proatividade (alertas e revisão de escrita) e animação. Salva via a API do
// Companion (PUT /api/companion), a mesma de antes.
const MODE_LABEL = {
  silencioso: 'Silencioso', auxiliar: 'Auxiliar', proativo: 'Proativo', foco: 'Foco', apresentacao: 'Apresentação',
};
const MODE_DESC = {
  silencioso: 'Só responde quando chamado.',
  auxiliar: 'Sugestões discretas, sem interromper.',
  proativo: 'Avisa sobre erros, riscos e oportunidades.',
  foco: 'Fica oculto e mostra só alertas críticos.',
  apresentacao: 'Sem falas nem animações durante uma apresentação.',
};
const SENSITIVITY_LABEL = { baixa: 'Discreta', media: 'Normal', alta: 'Ativa' };

export function CompanionConfig({ companion, allModels = [], assistants = [], model, onClose }) {
  const { settings, options, saveSettings } = companion;
  const [local, setLocal] = useState(settings);
  const set = (patch) => setLocal(prev => ({ ...prev, ...patch }));

  const presets = options?.characterPresets || ['Luma', 'Clara', 'Pixel', 'Nova', 'Nexo', 'Fred', 'Echo'];
  const modes = options?.modes || Object.keys(MODE_LABEL);
  const anims = options?.animationLevels || ['completo', 'reduzido', 'nenhum'];
  const sensitivities = ['baixa', 'media', 'alta'];

  function save() { saveSettings(local); onClose(); }

  return (
    <Modal title="Copiloto — Personalização" icon={<Sparkles size={18} />} onClose={onClose} className="companionModal">
      <div className="cmpForm">
        <label className="cmpField switchRow">
          <span>Ativar o copiloto</span>
          <input type="checkbox" checked={local.enabled} onChange={e => set({ enabled: e.target.checked })} />
        </label>

        <div className="cmpField">
          <label>Nome do personagem</label>
          <div className="cmpPresets">
            {presets.map(p => (
              <button key={p} className={local.characterName === p ? 'on' : ''} onClick={() => set({ characterName: p })}>{p}</button>
            ))}
          </div>
          <input value={local.characterName} onChange={e => set({ characterName: e.target.value })} maxLength={40} placeholder="Nome do personagem" />
        </div>

        <div className="cmpField">
          <label>Persona (assistente do Studio)</label>
          <select value={local.assistantId || ''} onChange={e => set({ assistantId: e.target.value || null })}>
            <option value="">Nenhuma — usa o assistente atual da conversa</option>
            {assistants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <small>Escolha qual assistente dá voz e personalidade ao personagem.</small>
        </div>

        <div className="cmpField">
          <label>Modelo do copiloto</label>
          <ModelPicker models={allModels} value={local.model || model || ''} onChange={id => set({ model: id })} />
          <small>Deixe em branco para acompanhar o modelo atual da conversa. O chat e a revisão do copiloto usam este modelo.</small>
        </div>

        <div className="cmpField">
          <label>Modo de comportamento</label>
          <div className="cmpRadioGrid">
            {modes.map(m => (
              <button key={m} className={`cmpRadio ${local.mode === m ? 'on' : ''}`} onClick={() => set({ mode: m })}>
                <strong>{MODE_LABEL[m] || m}</strong>
                <span>{MODE_DESC[m]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="cmpSectionTitle">Proatividade</div>

        <label className="cmpField switchRow">
          <span>Alertas proativos <small>(erros recorrentes, tarefas que falham, execuções presas)</small></span>
          <input type="checkbox" checked={local.proactiveAlerts} onChange={e => set({ proactiveAlerts: e.target.checked })} />
        </label>

        <label className="cmpField switchRow">
          <span>Revisão de escrita no chat principal <small>(o copiloto se oferece para revisar o que você digita)</small></span>
          <input type="checkbox" checked={local.proactiveWriting} onChange={e => set({ proactiveWriting: e.target.checked })} />
        </label>

        {local.proactiveWriting && (
          <div className="cmpField">
            <label>Frequência da oferta de revisão</label>
            <div className="cmpPresets">
              {sensitivities.map(s => (
                <button key={s} className={local.writingSensitivity === s ? 'on' : ''} onClick={() => set({ writingSensitivity: s })}>
                  {SENSITIVITY_LABEL[s]}
                </button>
              ))}
            </div>
            <small>Discreta só se oferece em textos mais longos; Ativa se oferece mais cedo.</small>
          </div>
        )}

        <div className="cmpSectionTitle">Aparência</div>

        <div className="cmpField">
          <label>Nível de animação</label>
          <div className="cmpPresets">
            {anims.map(a => (
              <button key={a} className={local.animationLevel === a ? 'on' : ''} onClick={() => set({ animationLevel: a })}>
                {a === 'completo' ? 'Completo' : a === 'reduzido' ? 'Reduzido' : 'Nenhum'}
              </button>
            ))}
          </div>
          <small>Reduza para economizar recursos em máquinas mais simples.</small>
        </div>

        <div className="cmpFieldNote">
          <ShieldCheck size={13} /> Diagnósticos, saúde do sistema e permissões de autonomia ficam em <b>Configurações › Agente › Copiloto (diagnósticos)</b>.
        </div>

        <div className="cmpFormActions">
          <button className="ghost" onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={save}>Salvar</button>
        </div>
      </div>
    </Modal>
  );
}
