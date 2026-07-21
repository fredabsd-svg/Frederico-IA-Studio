import React, { useEffect, useRef, useState } from 'react';
import { Layers, Plus, X, Check, ChevronDown, Save, Trash2, Users, Coins } from 'lucide-react';
import { API } from '../constants.js';
import { MULTI_MODE_LABEL } from './MultiModelBoard.jsx';

// Seletor MULTIMODELO da barra superior: liga/desliga o modo, escolhe os
// modelos e a função de cada um, o modo de colaboração, o coordenador, o
// contexto compartilhado e os limites de custo — além de salvar e aplicar
// equipes predefinidas (presets).

export const MULTI_ROLE_OPTIONS = [
  { id: 'principal', label: 'Modelo principal' },
  { id: 'revisor', label: 'Revisor crítico' },
  { id: 'pesquisador', label: 'Pesquisador' },
  { id: 'codigo', label: 'Especialista em código' },
  { id: 'arquiteto', label: 'Arquiteto de software' },
  { id: 'implementador', label: 'Implementador' },
  { id: 'seguranca', label: 'Especialista em segurança' },
  { id: 'testador', label: 'Testador' },
  { id: 'tributario', label: 'Especialista tributário' },
  { id: 'contabil', label: 'Especialista contábil' },
  { id: 'juridico', label: 'Especialista jurídico' },
  { id: 'livre', label: 'Função livre' }
];

const MODE_DESC = {
  compare: 'Todos respondem em paralelo e as respostas ficam lado a lado para você comparar.',
  council: 'Todos respondem e um coordenador consolida: concordâncias, divergências e resposta final.',
  debate: 'Rodadas controladas: cada modelo critica as respostas dos outros e revisa a sua; o coordenador fecha.',
  pipeline: 'Execução em sequência: cada modelo recebe o que os anteriores produziram (especialistas em cadeia).'
};

const CONTEXT_OPTIONS = [
  { id: 'recent', label: 'Últimas mensagens', desc: 'Envia um recorte recente da conversa (padrão).' },
  { id: 'full', label: 'Histórico amplo', desc: 'Envia mais mensagens — mais contexto, mais custo.' },
  { id: 'summary', label: 'Resumo da conversa', desc: 'Envia o resumo salvo (barato); sem resumo, usa o recorte recente.' },
  { id: 'none', label: 'Sem contexto anterior', desc: 'Só a mensagem atual e a função de cada modelo.' }
];

export const DEFAULT_MULTI_CONFIG = {
  mode: 'compare',
  models: [],
  coordinator: '',
  rounds: 2,
  maxTokensPerModel: null,
  budgetUsd: null,
  context: 'recent'
};

// Estimativa de custo ANTES de executar, com os preços do catálogo (entrada e
// saída por token). É uma ordem de grandeza — o custo real depende do tamanho
// do contexto e da resposta de cada modelo.
export function estimateMultiCost(config, models, messageChars = 800) {
  if (!config?.models?.length) return null;
  const byId = new Map(models.map(m => [m.id, m]));
  const inTokens = Math.ceil(messageChars / 4) + (config.context === 'none' ? 200 : config.context === 'full' ? 6000 : 2000);
  const outTokens = Math.min(config.maxTokensPerModel || 900, 900);
  const callsPerModel = config.mode === 'debate' ? (config.rounds || 2) : 1;
  let total = 0;
  let unknown = false;
  for (const member of config.models) {
    const m = byId.get(member.id);
    if (!m) { unknown = true; continue; }
    const pIn = Number(m.price || 0);
    const pOut = Number(m.priceOut || 0);
    if (!pIn && !pOut && !(m.free || m.id.endsWith(':free'))) { unknown = true; continue; }
    total += callsPerModel * (inTokens * pIn + outTokens * pOut);
  }
  if (config.mode === 'council' || config.mode === 'debate') {
    const coord = byId.get(config.coordinator || config.models[0]?.id);
    if (coord) total += (inTokens + config.models.length * 700) * Number(coord.price || 0) + 900 * Number(coord.priceOut || 0);
  }
  return { totalUsd: total, unknown };
}

const EXPENSIVE_PROMPT_PRICE = 0.000005; // ~US$5 por milhão de tokens de entrada

export function MultiModelPicker({ models, value, onChange, showToast }) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');
  const ref = useRef(null);

  const enabled = Boolean(value?.enabled);
  const config = { ...DEFAULT_MULTI_CONFIG, ...(value?.config || {}) };
  const patch = (p) => onChange({ enabled: true, config: { ...config, ...p } });

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  useEffect(() => {
    if (!open || presetsLoaded) return;
    (async () => {
      try {
        const r = await fetch(`${API}/api/model-teams`);
        if (r.ok) setPresets(await r.json());
      } catch {}
      setPresetsLoaded(true);
    })();
  }, [open, presetsLoaded]);

  const sorted = [...models].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  const byId = new Map(models.map(m => [m.id, m]));
  const defaultModelId = sorted.find(m => !m.id.endsWith(':free'))?.id || sorted[0]?.id || '';
  const estimate = estimateMultiCost(config, models);
  const expensive = config.models.some(mm => Number(byId.get(mm.id)?.price || 0) >= EXPENSIVE_PROMPT_PRICE);
  const needsCoordinator = config.mode === 'council' || config.mode === 'debate';
  const ready = config.models.length >= 2;

  function addModel() {
    if (config.models.length >= 6) { showToast?.('Limite de 6 modelos por execução.'); return; }
    const used = new Set(config.models.map(m => m.id));
    const next = sorted.find(m => !used.has(m.id) && m.capabilities?.text !== false)?.id || defaultModelId;
    patch({ models: [...config.models, { id: next, role: config.models.length === 0 ? 'principal' : 'revisor' }] });
  }
  function setMember(i, p) {
    patch({ models: config.models.map((m, idx) => idx === i ? { ...m, ...p } : m) });
  }
  function removeMember(i) {
    patch({ models: config.models.filter((_, idx) => idx !== i) });
  }

  async function savePreset() {
    const name = presetName.trim();
    if (!name) { showToast?.('Dê um nome para a equipe.'); return; }
    if (!ready) { showToast?.('Selecione ao menos 2 modelos antes de salvar.'); return; }
    setSavingPreset(true);
    try {
      const r = await fetch(`${API}/api/model-teams`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível salvar a equipe.');
      setPresets(prev => [d, ...prev]);
      setPresetName('');
      showToast?.(`Equipe "${name}" salva!`, 'ok');
    } catch (e) {
      showToast?.(e.message || 'Não foi possível salvar a equipe.');
    } finally {
      setSavingPreset(false);
    }
  }
  async function deletePreset(id, e) {
    e.stopPropagation();
    try {
      await fetch(`${API}/api/model-teams/${id}`, { method: 'DELETE' });
      setPresets(prev => prev.filter(p => p.id !== id));
    } catch {}
  }
  function applyPreset(preset) {
    onChange({ enabled: true, config: { ...DEFAULT_MULTI_CONFIG, ...preset.config } });
    showToast?.(`Equipe "${preset.name}" aplicada.`, 'ok');
  }

  return <div className="ctxPicker mmPicker" ref={ref}>
    <button className={`ctxBtn ${open ? 'on' : ''} ${enabled && ready ? 'mmOn' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}
            title="Multimodelo: use 2 ou mais IAs na mesma mensagem">
      <Layers size={15}/>
      <span className="ctxBtnText">
        <b>Multimodelo{enabled && ready ? ` (${config.models.length})` : ''}</b>
        <small>{enabled && ready ? (MULTI_MODE_LABEL[config.mode] || config.mode) : 'desligado'}</small>
      </span>
      <ChevronDown size={14}/>
    </button>
    {open && <div className="ctxPanel mmPanel">
      <div className="mmPanelScroll">
        <label className="mmToggle">
          <input type="checkbox" checked={enabled} onChange={e => onChange({ enabled: e.target.checked, config })}/>
          <span><b>Usar vários modelos nesta conversa</b><small>Cada modelo é uma chamada independente — o custo aumenta com cada modelo adicionado.</small></span>
        </label>

        {enabled && <>
          <div className="mmSectionTitle">Modo de colaboração</div>
          <div className="mmModes">
            {Object.entries(MULTI_MODE_LABEL).map(([id, label]) => (
              <button key={id} className={`mmMode ${config.mode === id ? 'sel' : ''}`} onClick={() => patch({ mode: id })}>
                <b>{label}{config.mode === id && <Check size={13}/>}</b>
                <small>{MODE_DESC[id]}</small>
              </button>
            ))}
          </div>

          <div className="mmSectionTitle">Modelos e funções {config.mode === 'pipeline' && <small>(a ordem é a ordem de execução)</small>}</div>
          <div className="mmMembers">
            {config.models.map((member, i) => {
              const info = byId.get(member.id);
              return <div key={i} className="mmMemberRow">
                <span className="mmMemberIdx">{i + 1}</span>
                <select value={member.id} onChange={e => setMember(i, { id: e.target.value })} title={member.id}>
                  {!byId.has(member.id) && <option value={member.id}>{member.id}</option>}
                  {sorted.map(m => <option key={m.id} value={m.id} disabled={m.capabilities?.text === false}>{m.name || m.id}{m.free || m.id.endsWith(':free') ? ' · grátis' : ''}</option>)}
                </select>
                <select value={member.role || 'livre'} onChange={e => setMember(i, { role: e.target.value })}>
                  {MULTI_ROLE_OPTIONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                {Number(info?.price || 0) >= EXPENSIVE_PROMPT_PRICE && <span className="mmPriceyBadge" title="Modelo de custo alto">$$$</span>}
                <button className="mmMemberDel" onClick={() => removeMember(i)} aria-label="Remover modelo"><X size={13}/></button>
              </div>;
            })}
            {config.models.length < 6 && <button className="mmAddModel" onClick={addModel}><Plus size={14}/> Adicionar modelo</button>}
            {!ready && <p className="ctxWarn">Selecione ao menos 2 modelos para ativar o multimodelo.</p>}
          </div>

          {needsCoordinator && <div className="mmFieldRow">
            <label>Coordenador (consolida a resposta final)
              <select value={config.coordinator || config.models[0]?.id || ''} onChange={e => patch({ coordinator: e.target.value })}>
                {config.models.map((m, i) => <option key={i} value={m.id}>{byId.get(m.id)?.name || m.id}</option>)}
                {sorted.filter(m => !config.models.some(x => x.id === m.id)).map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
              </select>
            </label>
            {config.mode === 'debate' && <label>Rodadas
              <select value={config.rounds || 2} onChange={e => patch({ rounds: Number(e.target.value) })}>
                <option value={1}>1 (sem crítica)</option>
                <option value={2}>2 (resposta + revisão)</option>
                <option value={3}>3 (revisão dupla)</option>
              </select>
            </label>}
          </div>}

          <div className="mmSectionTitle">Contexto compartilhado</div>
          <div className="mmFieldRow">
            <label>O que cada modelo recebe da conversa
              <select value={config.context || 'recent'} onChange={e => patch({ context: e.target.value })}>
                {CONTEXT_OPTIONS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
          </div>
          <p className="mmHint">{CONTEXT_OPTIONS.find(c => c.id === (config.context || 'recent'))?.desc}</p>

          <div className="mmSectionTitle">Controle de custos</div>
          <div className="mmFieldRow">
            <label>Orçamento máximo (US$)
              <input type="number" min="0" step="0.05" placeholder="sem limite" value={config.budgetUsd ?? ''}
                onChange={e => patch({ budgetUsd: e.target.value === '' ? null : Number(e.target.value) })}/>
            </label>
            <label>Tokens máx. por modelo
              <input type="number" min="256" step="256" placeholder="automático" value={config.maxTokensPerModel ?? ''}
                onChange={e => patch({ maxTokensPerModel: e.target.value === '' ? null : Number(e.target.value) })}/>
            </label>
          </div>
          {estimate && ready && <p className="mmEstimate"><Coins size={13}/> Estimativa por mensagem: {estimate.totalUsd === 0 ? 'grátis' : `~US$ ${estimate.totalUsd < 0.01 ? estimate.totalUsd.toFixed(4) : estimate.totalUsd.toFixed(2)}`}{estimate.unknown ? ' (alguns modelos sem preço no catálogo)' : ''} — varia com o tamanho do contexto e das respostas.</p>}
          {expensive && <p className="mmExpensiveWarn">⚠ Há modelos de custo alto na equipe. Considere usar modelos econômicos nas funções secundárias.</p>}

          <div className="mmSectionTitle">Equipes salvas</div>
          {presets.length === 0 && <p className="mmHint">Monte a equipe acima e salve para reutilizar (ex.: "Equipe econômica", "Equipe de programação").</p>}
          <div className="mmPresets">
            {presets.map(p => (
              <div key={p.id} className="mmPresetRow">
                <button className="mmPresetApply" onClick={() => applyPreset(p)} title={`${(p.config?.models || []).map(m => m.id).join(', ')}`}>
                  <Users size={13}/>
                  <span><b>{p.name}</b><small>{MULTI_MODE_LABEL[p.config?.mode] || p.config?.mode} · {(p.config?.models || []).length} modelos</small></span>
                </button>
                <button className="mmPresetDel" onClick={(e) => deletePreset(p.id, e)} aria-label={`Excluir equipe ${p.name}`}><Trash2 size={13}/></button>
              </div>
            ))}
          </div>
          <div className="mmPresetSave">
            <input value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="Nome da nova equipe..." maxLength={120}/>
            <button onClick={savePreset} disabled={savingPreset || !ready}><Save size={13}/> Salvar equipe</button>
          </div>
        </>}
      </div>
    </div>}
  </div>;
}
