import React, { useEffect, useState } from 'react';
import { CalendarClock, X, Play, Power } from 'lucide-react';
import { API, assistantOptionPrefix } from './constants.js';
import { Drawer } from './components.jsx';

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const emptyRoutine = () => ({ title: '', prompt: '', assistant_id: '', client_id: '', cadence: 'monthly', day: 5, hour: 8, web_search: false });

function describe(r) {
  const at = `às ${String(r.hour).padStart(2, '0')}h`;
  if (r.cadence === 'daily') return `Todo dia ${at}`;
  if (r.cadence === 'weekly') return `Toda ${WEEKDAYS[r.day] || 'semana'} ${at}`;
  return `Todo dia ${r.day} do mês ${at}`;
}

export function RoutinesPanel({ assistants = [], clients = [], showToast, onClose, askConfirm }) {
  const [items, setItems] = useState(null);
  const [form, setForm] = useState(emptyRoutine());
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => { load(); }, []);
  async function load() {
    try { const d = await (await fetch(`${API}/api/schedules`)).json(); setItems(Array.isArray(d) ? d : []); }
    catch { setItems([]); }
  }
  async function create() {
    if (!form.title.trim() || !form.prompt.trim()) { showToast('Dê um nome e diga o que a rotina deve fazer.'); return; }
    try {
      const res = await fetch(`${API}/api/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '');
      setForm(emptyRoutine());
      showToast('Rotina criada. Ela roda sozinha na hora marcada (o app precisa estar ligado).', 'ok');
      load();
    } catch (e) { showToast(e.message || 'Não foi possível criar a rotina.'); }
  }
  async function toggle(r) {
    try { await fetch(`${API}/api/schedules/${r.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: r.enabled ? 0 : 1 }) }); load(); } catch {}
  }
  async function runNow(r) {
    try { await fetch(`${API}/api/schedules/${r.id}/run`, { method: 'POST' }); showToast('Rotina disparada agora — acompanhe em "Tarefas".', 'ok'); } catch {}
  }
  async function remove(id) {
    if (!await askConfirm({ title: 'Excluir rotina?', message: 'Ela deixará de ser executada automaticamente.', confirmLabel: 'Excluir', destructive: true })) return;
    try { await fetch(`${API}/api/schedules/${id}`, { method: 'DELETE' }); load(); } catch {}
  }

  return <Drawer title="Rotinas automáticas" icon={<CalendarClock size={18}/>} onClose={onClose} className="routinesDrawer">
    <p className="drawerIntro">Programe tarefas para rodarem sozinhas. Na hora marcada, o app cria a tarefa e o resultado aparece em <b>Tarefas</b>. O computador precisa estar ligado com o app aberto.</p>

    <label>Nome da rotina
      <input value={form.title} onChange={e => set('title', e.target.value)} placeholder="Ex.: Relatório mensal — Padaria do João"/>
    </label>
    <label>O que a IA deve fazer
      <textarea rows={3} value={form.prompt} onChange={e => set('prompt', e.target.value)} placeholder="Descreva a tarefa como se estivesse pedindo no chat. Ex.: Gere um resumo do faturamento do mês e uma planilha com os principais números."/>
    </label>
    <div className="frow">
      <label className="grow">Assistente
        <select value={form.assistant_id} onChange={e => set('assistant_id', e.target.value)}>
          <option value="">Padrão</option>
          {assistants.map(a => <option key={a.id} value={a.id}>{assistantOptionPrefix(a.emoji)}{a.name}</option>)}
        </select>
      </label>
      <label className="grow">Cliente
        <select value={form.client_id} onChange={e => set('client_id', e.target.value)}>
          <option value="">Geral</option>
          {clients.map(c => <option key={c.id} value={c.id}>👤 {c.name}</option>)}
        </select>
      </label>
    </div>
    <div className="frow">
      <label className="grow">Frequência
        <select value={form.cadence} onChange={e => set('cadence', e.target.value)}>
          <option value="daily">Todo dia</option>
          <option value="weekly">Toda semana</option>
          <option value="monthly">Todo mês</option>
        </select>
      </label>
      {form.cadence === 'weekly' && <label className="grow">Dia da semana
        <select value={form.day} onChange={e => set('day', Number(e.target.value))}>
          {WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}</option>)}
        </select>
      </label>}
      {form.cadence === 'monthly' && <label className="grow">Dia do mês
        <input type="number" min="1" max="31" value={form.day} onChange={e => set('day', Number(e.target.value))}/>
      </label>}
      <label className="emojiField" style={{ width: 90 }}>Hora
        <input type="number" min="0" max="23" value={form.hour} onChange={e => set('hour', Number(e.target.value))}/>
      </label>
    </div>
    <label className="chk"><input type="checkbox" checked={form.web_search} onChange={e => set('web_search', e.target.checked)}/> Permitir pesquisa na internet nesta rotina</label>
    <button className="primary" onClick={create}>Criar rotina</button>

    <div className="memList">
      {items === null && <div className="working"><span className="spin"/><span>Carregando...</span></div>}
      {items?.length === 0 && <p className="muted">Nenhuma rotina ainda.</p>}
      {items?.map(r => (
        <div className={`routineItem ${r.enabled ? '' : 'off'}`} key={r.id}>
          <div className="rInfo">
            <b>{r.title}</b>
            <small>{describe(r)}{r.last_run ? ` · última: ${r.last_run}` : ''}</small>
          </div>
          <button className="rBtn" onClick={() => runNow(r)} title="Executar agora"><Play size={14}/></button>
          <button className={`rBtn ${r.enabled ? 'on' : ''}`} onClick={() => toggle(r)} title={r.enabled ? 'Pausar' : 'Ativar'}><Power size={14}/></button>
          <button className="memDelBtn" onClick={() => remove(r.id)} title="Excluir"><X size={15}/></button>
        </div>
      ))}
    </div>
  </Drawer>;
}
