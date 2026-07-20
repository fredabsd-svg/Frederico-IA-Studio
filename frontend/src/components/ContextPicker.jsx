import React, { useEffect, useRef, useState } from 'react';
import { Bot, Users, Cpu, Check, Settings, ChevronDown, Calculator, FilePenLine, Code2, Telescope, Scale, Briefcase, BarChart3, Receipt, Landmark, Megaphone, Lightbulb, ShieldCheck, GraduationCap, Stethoscope, Hammer, Leaf } from 'lucide-react';
import { ASSISTANT_COLORS } from '../constants.js';
import { ModelPicker } from '../components.jsx';

// Mapa explícito em vez de Lucide[nome] sobre `import * as Lucide`: o import
// estrela puxaria os ~1500 ícones da biblioteca para o bundle, porque mata o
// tree-shaking. As chaves espelham ASSISTANT_ICONS em constants.js.
export const ASSISTANT_ICON = {
  'bot': Bot,
  'calculator': Calculator,
  'file-pen-line': FilePenLine,
  'code-2': Code2,
  'telescope': Telescope,
  'scale': Scale,
  'briefcase': Briefcase,
  'bar-chart-3': BarChart3,
  'receipt': Receipt,
  'landmark': Landmark,
  'megaphone': Megaphone,
  'lightbulb': Lightbulb,
  'shield-check': ShieldCheck,
  'graduation-cap': GraduationCap,
  'stethoscope': Stethoscope,
  'hammer': Hammer,
  'leaf': Leaf
};

const assistantColor = (a, i = 0) => a?.color || ASSISTANT_COLORS[i % ASSISTANT_COLORS.length];

// Desenha o ícone do assistente. Se o valor não for um nome de ícone conhecido,
// é um emoji de um assistente criado antes da migração: imprime como texto.
export function AssistantGlyph({ value, size = 14 }) {
  const Icon = ASSISTANT_ICON[value];
  if (Icon) return <Icon size={size}/>;
  return <span className="glyphEmoji" style={{ fontSize: size }}>{value || '🤖'}</span>;
}

// Ladrilho colorido do assistente (ContextPicker e cabeçalho das mensagens).
export function AssistantTile({ assistant, index = 0, size = 26, icon = 14 }) {
  const color = assistantColor(assistant, index);
  return <span className="asstTile" style={{
    width: size, height: size, color,
    background: `color-mix(in srgb, ${color} 16%, transparent)`
  }}>
    <AssistantGlyph value={assistant?.emoji} size={icon}/>
  </span>;
}

const modelCapability = (model, key) => {
  const declared = model?.capabilities;
  if (declared && Object.prototype.hasOwnProperty.call(declared, key)) return declared[key];
  return model?.[key];
};
export const modelHasTools = model => modelCapability(model, 'tools') !== false;
const modelCompatibilityLabel = (model) => {
  if (modelCapability(model, 'text') === false) return 'sem chat em texto';
  if (modelCapability(model, 'tools') === false) return 'somente texto';
  if (modelCapability(model, 'tools') === true) return 'com ferramentas';
  return 'texto';
};

// Controle único de contexto da barra superior.
//
// Antes: rótulo do espaço de trabalho + ModelPicker + botão Equipe + <select> de
// assistente + engrenagem de editar — quatro controles lado a lado para a mesma
// pergunta ("quem responde?"), sendo que ligar a Equipe desabilitava os vizinhos
// sem explicar por quê.
//
// Agora: um botão, três abas. A aba É o modo — abrir "Equipe" liga a equipe,
// abrir "Assistente" desliga. Nada é desabilitado, porque nada compete.
export function ContextPicker({ models, model, onModel, assistants, assistantId, onPickAssistant,
                         currentAssistant, team, onTeam, teamIds, onToggleMember,
                         effectiveTeam, onEditAssistant }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(team ? 'team' : 'assistant');
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  useEffect(() => { setTab(t => (team && t === 'assistant') ? 'team' : (!team && t === 'team') ? 'assistant' : t); }, [team]);

  const currentModel = models.find(m => m.id === model);
  const who = team
    ? `Equipe (${effectiveTeam.length})`
    : (currentAssistant?.name || 'Assistente');

  function goTab(id) {
    setTab(id);
    if (id === 'team') onTeam(true);
    if (id === 'assistant') onTeam(false);
  }

  return <div className="ctxPicker" ref={ref}>
    <button className={`ctxBtn ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}
            title="Quem responde e com qual modelo de IA">
      {team ? <Users size={15}/> : <AssistantGlyph value={currentAssistant?.emoji} size={15}/>}
      <span className="ctxBtnText">
        <b>{who}</b>
        <small>{currentModel?.name || model}{currentModel && ` · ${modelCompatibilityLabel(currentModel)}`}</small>
      </span>
      <ChevronDown size={14}/>
    </button>
    {open && <div className="ctxPanel">
      <div className="ctxTabs" role="tablist" aria-label="Contexto da conversa">
        <button role="tab" aria-selected={tab === 'assistant'} className={tab === 'assistant' ? 'on' : ''} onClick={() => goTab('assistant')}><Bot size={14}/> Assistente</button>
        <button role="tab" aria-selected={tab === 'team'} className={tab === 'team' ? 'on' : ''} onClick={() => goTab('team')}><Users size={14}/> Equipe</button>
        <button role="tab" aria-selected={tab === 'model'} className={tab === 'model' ? 'on' : ''} onClick={() => setTab('model')}><Cpu size={14}/> Modelo</button>
      </div>

      {tab === 'assistant' && <div className="ctxBody" role="tabpanel">
        <p className="ctxHint">Um assistente responde sozinho, com a memória e as ferramentas dele.</p>
        <div className="ctxList">
          {assistants.map((a, i) => (
            <button key={a.id} className={`ctxItem ${!team && a.id === assistantId ? 'sel' : ''}`}
                    onClick={() => { onPickAssistant(a.id); onTeam(false); }}>
              <AssistantTile assistant={a} index={i}/>
              <span className="ctxItemName">{a.name}</span>
              {!team && a.id === assistantId && <Check size={14} className="ctxItemChk"/>}
            </button>
          ))}
        </div>
        <button className="ctxFoot" onClick={onEditAssistant}><Settings size={14}/> Editar este assistente</button>
      </div>}

      {tab === 'team' && <div className="ctxBody" role="tabpanel">
        <p className="ctxHint">Vários assistentes respondem à <b>1ª mensagem</b> e um coordenador junta as perspectivas. Depois ele segue sozinho, para reduzir custo e tempo.</p>
        <div className="ctxList">
          {assistants.map((a, i) => {
            const on = !teamIds || teamIds.includes(a.id);
            return <label key={a.id} className={`ctxItem ctxCheck ${on ? 'sel' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => onToggleMember(a.id)}/>
              <AssistantTile assistant={a} index={i}/>
              <span className="ctxItemName">{a.name}</span>
            </label>;
          })}
        </div>
        {effectiveTeam.length === 0 && <p className="ctxWarn">Selecione ao menos um assistente.</p>}
      </div>}

      {tab === 'model' && <div className="ctxBody ctxBodyModel" role="tabpanel">
        <ModelPicker models={models} value={model} onChange={onModel} inline/>
      </div>}
    </div>}
  </div>;
}
