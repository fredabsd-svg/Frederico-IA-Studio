import React from 'react';
import { CalendarDays, BellPlus } from 'lucide-react';
import { API, FISCAL_CALENDAR, FISCAL_ANNUAL } from './constants.js';
import { Modal } from './components.jsx';

// Dias restantes até o próximo dia `d` do mês (a partir de hoje).
function nextDue(d) {
  const now = new Date();
  const today = now.getDate();
  let due = new Date(now.getFullYear(), now.getMonth(), d);
  if (today > d) due = new Date(now.getFullYear(), now.getMonth() + 1, d);
  const days = Math.round((due - new Date(now.getFullYear(), now.getMonth(), today)) / 86400000);
  return { due, days };
}

export function FiscalPanel({ showToast, onClose }) {
  const items = FISCAL_CALENDAR
    .map(o => ({ ...o, ...nextDue(o.day) }))
    .sort((a, b) => a.days - b.days);

  async function remind(o) {
    const body = {
      title: `Lembrete: ${o.name}`,
      prompt: `Isto é um lembrete automático: a obrigação "${o.name}" vence por volta do dia ${o.day} deste mês (${o.desc}). Liste o que preciso providenciar e, se der, prepare um checklist ou um rascunho para adiantar.`,
      cadence: 'monthly',
      day: Math.max(1, o.day - 2),
      hour: 8
    };
    try {
      const res = await fetch(`${API}/api/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error();
      showToast(`Lembrete mensal criado (2 dias antes). Veja em "Rotinas".`, 'ok');
    } catch { showToast('Não foi possível criar o lembrete.'); }
  }

  return <Modal title="Calendário fiscal" icon={<CalendarDays size={18}/>} onClose={onClose}>
    <div className="pcWarn">⚠️ Datas de <b>referência</b>. Elas mudam conforme feriado/fim de semana, UF/município e o ano. Confirme sempre no calendário oficial (Receita, Sefaz, prefeitura).</div>

    <div className="fiscalList">
      {items.map((o, i) => (
        <div className={`fiscalItem ${o.days <= 3 ? 'soon' : ''}`} key={i}>
          <div className="fDay"><b>{String(o.day).padStart(2, '0')}</b><small>dia</small></div>
          <div className="fInfo">
            <b>{o.name}</b>
            <small>{o.desc}</small>
          </div>
          <div className="fCount">{o.days === 0 ? 'hoje' : o.days === 1 ? 'amanhã' : `em ${o.days} dias`}</div>
          <button className="rBtn" onClick={() => remind(o)} title="Criar lembrete mensal (rotina)"><BellPlus size={15}/></button>
        </div>
      ))}
    </div>

    <div className="fieldLabel" style={{ marginTop: 6 }}>Anuais (informativo)</div>
    <div className="fiscalAnnual">
      {FISCAL_ANNUAL.map((a, i) => (
        <div className="fAnnual" key={i}><span className="fWhen">{a.when}</span><b>{a.name}</b><small>{a.desc}</small></div>
      ))}
    </div>
  </Modal>;
}
