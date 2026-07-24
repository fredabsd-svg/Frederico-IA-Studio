import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, X, Settings, Sparkles, Send, Bug, Plus, Minus, ChevronRight, ShieldCheck, Cpu, Moon } from 'lucide-react';
import { Modal, ModelPicker } from './components.jsx';
import { AssistantGlyph } from './components/ContextPicker.jsx';

// Frederico Companion — a representação visual e interativa do Studio (o "colega
// de trabalho digital"). É apenas a CAMADA de experiência: a inteligência vem do
// núcleo do Studio (modelos, provedores, memória, ferramentas, modo dev). Aqui
// cuidamos de presença, estados visuais, alertas e atalhos.

// Rótulos legíveis dos modos de comportamento (seção 5 da proposta).
const MODE_LABEL = {
  silencioso: 'Silencioso',
  auxiliar: 'Auxiliar',
  proativo: 'Proativo',
  foco: 'Foco',
  apresentacao: 'Apresentação',
};
const MODE_DESC = {
  silencioso: 'Só responde quando chamado.',
  auxiliar: 'Sugestões discretas, sem interromper.',
  proativo: 'Avisa sobre erros, riscos e oportunidades.',
  foco: 'Fica oculto e mostra só alertas críticos.',
  apresentacao: 'Sem falas nem animações durante uma apresentação.',
};

// Uma frase curta que o personagem "diz" em cada estado — transparência sobre o
// que está acontecendo, em vez de um "Pensando..." opaco (seção 11).
const STATE_CAPTION = {
  disponivel: 'Pronto para ajudar',
  escutando: 'Ouvindo você...',
  pensando: 'Analisando...',
  executando: 'Executando ação...',
  alerta: 'Encontrei algo para você ver',
  erro: 'Algo falhou',
  sucesso: 'Feito!',
  silencioso: 'Modo silencioso',
  ausente: 'De férias',
};

// O personagem em si: um "orb" amigável com rosto, desenhado em SVG e animado
// por CSS conforme o estado. Barato e sem dependências de 3D — o MVP prova a
// utilidade antes do avatar sofisticado (seção 12).
function CompanionAvatar({ state, name, color = '#4f8cff' }) {
  return (
    <div className={`cmpAvatar state-${state}`} aria-label={`${name}: ${STATE_CAPTION[state] || ''}`}>
      <svg viewBox="0 0 100 100" width="100%" height="100%" role="img" aria-hidden="true">
        <defs>
          <radialGradient id="cmpBody" cx="38%" cy="32%" r="75%">
            <stop offset="0%" stopColor={color} stopOpacity="0.95" />
            <stop offset="100%" stopColor={color} stopOpacity="0.55" />
          </radialGradient>
        </defs>
        {/* antena — reage nos estados de escuta/pensamento */}
        <line className="cmpAntenna" x1="50" y1="16" x2="50" y2="4" stroke={color} strokeWidth="3" strokeLinecap="round" />
        <circle className="cmpAntennaDot" cx="50" cy="4" r="4" fill={color} />
        {/* corpo */}
        <circle className="cmpBody" cx="50" cy="56" r="34" fill="url(#cmpBody)" />
        {/* olhos */}
        <g className="cmpEyes" fill="#0b1220">
          <circle className="cmpEye left" cx="39" cy="52" r="5.2" />
          <circle className="cmpEye right" cx="61" cy="52" r="5.2" />
        </g>
        {/* boca — muda conforme humor */}
        <path className="cmpMouth" d="M40 68 Q50 76 60 68" fill="none" stroke="#0b1220" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="cmpPulse" aria-hidden="true" />
    </div>
  );
}

export function Companion({
  companion,           // retorno do useCompanion
  busy, statusText, listening,
  model, allModels = [], assistants = [], assistantId,
  onSend, onSetModel, onNewChat, onOpenDeveloper, onOpenAssistants, onOpenCopilot,
  showToast,
}) {
  const { settings, persona, events, options, saveSettings, dismissEvent, resolveEvent, dismissAll } = companion;
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(() => localStorage.getItem('fred_companion_min') === '1');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quick, setQuick] = useState('');
  const [pos, setPos] = useState(() => {
    try { const p = JSON.parse(localStorage.getItem('fred_companion_pos') || 'null'); if (p && typeof p.x === 'number') return p; } catch {}
    return null; // null = ancorado no canto inferior direito (CSS)
  });
  const [successFlash, setSuccessFlash] = useState(false);
  const panelRef = useRef(null);
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const prevBusy = useRef(busy);

  const unread = useMemo(() => events.filter(e => e.status === 'novo' || e.status === 'visto'), [events]);
  const hasCritical = unread.some(e => e.level === 'critico');
  const hasWarning = unread.some(e => e.level === 'aviso');

  // Pequena reação positiva quando uma execução termina (busy: true -> false).
  useEffect(() => {
    if (prevBusy.current && !busy) {
      setSuccessFlash(true);
      const t = setTimeout(() => setSuccessFlash(false), 1600);
      return () => clearTimeout(t);
    }
    prevBusy.current = busy;
  }, [busy]);

  // Máquina de estados visual (seção 4). A ordem reflete prioridade.
  const state = useMemo(() => {
    if (settings.mode === 'apresentacao') return 'silencioso';
    if (busy) {
      const s = String(statusText || '').toLowerCase();
      return /execut|ferramenta|rodando|tool|comando/.test(s) ? 'executando' : 'pensando';
    }
    if (listening) return 'escutando';
    if (successFlash) return 'sucesso';
    if (hasCritical) return 'erro';
    if (hasWarning || unread.length) return 'alerta';
    return 'disponivel';
  }, [settings.mode, busy, statusText, listening, successFlash, hasCritical, hasWarning, unread.length]);

  // Fecha o painel ao clicar fora.
  useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Arrastar o personagem pela tela (seção 4). Guarda a posição no localStorage.
  function onAvatarPointerDown(e) {
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    let moved = false;
    dragRef.current = { x: rect.left, y: rect.top };
    function move(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      const nx = Math.min(window.innerWidth - 60, Math.max(8, dragRef.current.x + dx));
      const ny = Math.min(window.innerHeight - 60, Math.max(8, dragRef.current.y + dy));
      setPos({ x: nx, y: ny });
    }
    function up() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (moved) {
        setPos(p => { if (p) localStorage.setItem('fred_companion_pos', JSON.stringify(p)); return p; });
      } else {
        setOpen(o => !o); // clique sem arrastar = abre/fecha o painel
      }
    }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  if (!settings.enabled) return null;

  const characterName = settings.characterName || 'Luma';
  const personaColor = persona?.color || '#4f8cff';
  const activeModelId = settings.model || model || '';
  const activeModel = allModels.find(m => m.id === activeModelId);
  const modelLabel = activeModel?.name || activeModelId || 'modelo do Studio';

  function toggleMin() {
    setMinimized(m => { const nv = !m; localStorage.setItem('fred_companion_min', nv ? '1' : '0'); if (nv) setOpen(false); return nv; });
  }

  function submitQuick(e) {
    e?.preventDefault();
    const text = quick.trim();
    if (!text) return;
    if (!onSend) { showToast?.('Envio indisponível no momento.'); return; }
    onSend(text);
    setQuick('');
    setOpen(false);
    showToast?.(`${characterName} enviou sua mensagem ao Studio.`);
  }

  const rootStyle = pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined;
  const reduced = settings.animationLevel !== 'completo';

  return (
    <>
      <div
        ref={rootRef}
        className={`companionRoot anim-${settings.animationLevel} ${minimized ? 'min' : ''} ${open ? 'open' : ''}`}
        style={rootStyle}
      >
        {/* Painel (abre ao clicar no personagem) */}
        {open && !minimized && (
          <div className="companionPanel" ref={panelRef} role="dialog" aria-label={`Painel do ${characterName}`}>
            <div className="cmpPanelHead">
              <div className="cmpWho">
                <strong>{characterName}</strong>
                <span className="cmpCaption">{STATE_CAPTION[state]}</span>
              </div>
              <div className="cmpHeadActions">
                <button title="Silenciar/minimizar" onClick={toggleMin} aria-label="Minimizar"><Minus size={15} /></button>
                <button title="Configurar" onClick={() => setSettingsOpen(true)} aria-label="Configurar"><Settings size={15} /></button>
                <button title="Fechar" onClick={() => setOpen(false)} aria-label="Fechar"><X size={15} /></button>
              </div>
            </div>

            {/* Status da sessão: modelo em uso e atividade (transparência). */}
            <div className="cmpSession">
              <span className="cmpChip" title="Modelo responsável pelo Companion"><Cpu size={13} /> {modelLabel}</span>
              <span className={`cmpChip mode-${settings.mode}`} title="Modo de comportamento">{MODE_LABEL[settings.mode]}</span>
              {persona && <span className="cmpChip" title="Persona (assistente do Studio)"><AssistantGlyph value={persona.emoji} size={13} /> {persona.name}</span>}
            </div>

            {busy && (
              <div className="cmpLive"><span className="cmpSpin" /> {statusText || 'Trabalhando...'}</div>
            )}

            {/* Alertas / eventos proativos com o rastro de transparência. */}
            {unread.length > 0 && (
              <div className="cmpAlerts">
                <div className="cmpAlertsHead">
                  <span><Bell size={13} /> {unread.length} alerta{unread.length > 1 ? 's' : ''}</span>
                  <button className="cmpLink" onClick={dismissAll}>Limpar</button>
                </div>
                <ul>
                  {unread.slice(0, 4).map(e => (
                    <li key={e.id} className={`cmpAlert level-${e.level}`}>
                      <div className="cmpAlertTitle">{e.title}</div>
                      {e.detail && <div className="cmpAlertDetail">{e.detail}</div>}
                      {e.proposedAction && <div className="cmpAlertAction"><ChevronRight size={12} /> {e.proposedAction}</div>}
                      {e.authorization && <div className="cmpAlertAuth"><ShieldCheck size={11} /> {e.authorization}</div>}
                      <div className="cmpAlertBtns">
                        <button onClick={() => dismissEvent(e.id)}>Dispensar</button>
                        <button className="mut" onClick={() => resolveEvent(e.id, 'Marcado como resolvido pelo usuário.')}>Resolver</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Ações rápidas */}
            <div className="cmpQuickRow">
              <button onClick={() => { onNewChat?.(); setOpen(false); }}><Plus size={14} /> Nova conversa</button>
              {onOpenDeveloper && <button onClick={() => { onOpenDeveloper(); setOpen(false); }}><Bug size={14} /> Modo dev</button>}
              {onOpenAssistants && <button onClick={() => { onOpenAssistants(); setOpen(false); }}><Sparkles size={14} /> Assistentes</button>}
              {onOpenCopilot && <button onClick={() => { onOpenCopilot(); setOpen(false); }}><Bug size={14} /> Copiloto</button>}
            </div>

            {/* Modo de comportamento (troca rápida) */}
            <div className="cmpModes" role="group" aria-label="Modo de comportamento">
              {(options.modes || Object.keys(MODE_LABEL)).map(m => (
                <button
                  key={m}
                  className={`cmpMode ${settings.mode === m ? 'on' : ''}`}
                  title={MODE_DESC[m]}
                  onClick={() => saveSettings({ mode: m })}
                >{MODE_LABEL[m] || m}</button>
              ))}
            </div>

            {/* Envio rápido — delega ao chat do Studio na conversa aberta */}
            <form className="cmpQuick" onSubmit={submitQuick}>
              <input
                value={quick}
                onChange={e => setQuick(e.target.value)}
                placeholder={`Peça algo para ${characterName}...`}
                aria-label="Mensagem rápida"
              />
              <button type="submit" disabled={!quick.trim()} aria-label="Enviar"><Send size={15} /></button>
            </form>
          </div>
        )}

        {/* Balão quando minimizado (só o personagem visível) */}
        {minimized && (
          <button className="cmpMinBubble" onClick={toggleMin} title={`Reativar ${characterName}`}>
            <Moon size={14} /> {characterName}
          </button>
        )}

        {/* O personagem */}
        {!minimized && (
          <div className="cmpAvatarWrap" onPointerDown={onAvatarPointerDown} title={`${characterName} — clique para abrir, arraste para mover`}>
            {(hasCritical || hasWarning) && !busy && <span className={`cmpBadge ${hasCritical ? 'crit' : 'warn'}`}>{unread.length}</span>}
            <CompanionAvatar state={reduced && !busy ? 'disponivel' : state} name={characterName} color={personaColor} />
          </div>
        )}
      </div>

      {settingsOpen && (
        <CompanionSettings
          settings={settings}
          options={options}
          assistants={assistants}
          allModels={allModels}
          model={model}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}

// Modal de configuração do Companion (seção 6.2, 7, 8).
function CompanionSettings({ settings, options, assistants, allModels, model, onSave, onClose }) {
  const [local, setLocal] = useState(settings);
  const set = (patch) => setLocal(prev => ({ ...prev, ...patch }));
  const presets = options.characterPresets || ['Luma', 'Clara', 'Pixel', 'Nova', 'Nexo', 'Fred', 'Echo'];
  const modes = options.modes || Object.keys(MODE_LABEL);
  const anims = options.animationLevels || ['completo', 'reduzido', 'nenhum'];

  function save() { onSave(local); onClose(); }

  const PERM = [
    'Nível 1 — Somente leitura',
    'Nível 2 — Preparar ação (sem executar)',
    'Nível 3 — Executar com confirmação',
    'Nível 4 — Automação limitada (ações pré-autorizadas)',
    'Nível 5 — Autonomia avançada (com auditoria)',
  ];

  return (
    <Modal title="Frederico Companion" icon={<Sparkles size={18} />} onClose={onClose} className="companionModal">
      <div className="cmpForm">
        <label className="cmpField switchRow">
          <span>Ativar o Companion</span>
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
          <label>Modelo do Companion</label>
          <ModelPicker
            models={allModels}
            value={local.model || model || ''}
            onChange={id => set({ model: id })}
          />
          <small>Deixe como está para acompanhar o modelo atual da conversa. Você é livre para escolher qualquer modelo/provedor do Studio.</small>
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

        <label className="cmpField switchRow">
          <span>Alertas proativos <small>(erros recorrentes, tarefas que falham, execuções presas)</small></span>
          <input type="checkbox" checked={local.proactiveAlerts} onChange={e => set({ proactiveAlerts: e.target.checked })} />
        </label>

        <div className="cmpField">
          <label>Nível de permissão <ShieldCheck size={13} /></label>
          <select value={local.permissionLevel} onChange={e => set({ permissionLevel: Number(e.target.value) })}>
            {PERM.map((p, i) => <option key={i} value={i + 1}>{p}</option>)}
          </select>
          <small>Ações destrutivas, financeiras ou com dados sensíveis sempre pedem confirmação — mesmo no nível avançado.</small>
        </div>

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

        <div className="cmpFormActions">
          <button className="ghost" onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={save}>Salvar</button>
        </div>
      </div>
    </Modal>
  );
}
