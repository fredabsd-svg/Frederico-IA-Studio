import React, { useEffect, useState } from 'react';
import { API } from '../constants.js';
import { Drawer } from '../components.jsx';
import { Bot, Activity, ShieldCheck, Bug, FileDown, Cpu, HardDrive, MemoryStick, AlertTriangle, CheckCircle2, Octagon } from 'lucide-react';

const SEV_COLOR = { info: '#8b96af', baixa: '#38bdf8', media: '#f0a340', alta: '#f97316', critica: '#ef4444' };
const STATUS_LABEL = { aberto: 'Aberto', investigando: 'Investigando', resolvido: 'Resolvido', reaberto: 'Reaberto', ignorado: 'Ignorado' };

// Central do copiloto: Diagnósticos + Saúde + Permissões, sobre as APIs reais.
export function CopilotPanel({ copilot, onClose }) {
  const [tab, setTab] = useState('diag');
  useEffect(() => { copilot.loadAll(); }, []); // eslint-disable-line

  return (
    <Drawer title="Copiloto" icon={<Bot size={18} />} onClose={onClose} className="copilotDrawer">
      <div className="copTabs">
        <button className={tab === 'diag' ? 'on' : ''} onClick={() => setTab('diag')}><Bug size={14} /> Diagnósticos</button>
        <button className={tab === 'health' ? 'on' : ''} onClick={() => setTab('health')}><Activity size={14} /> Saúde</button>
        <button className={tab === 'perms' ? 'on' : ''} onClick={() => setTab('perms')}><ShieldCheck size={14} /> Permissões</button>
      </div>

      {tab === 'diag' && <Diagnostics copilot={copilot} />}
      {tab === 'health' && <Health health={copilot.health} onReload={copilot.loadHealth} />}
      {tab === 'perms' && <Permissions copilot={copilot} />}
    </Drawer>
  );
}

function Diagnostics({ copilot }) {
  const { incidents, updateIncident } = copilot;
  const [open, setOpen] = useState(null);
  if (!incidents.length) return <div className="copEmpty">Nenhum incidente registrado ainda. Quando o copiloto detectar erros recorrentes ou falhas, eles aparecem aqui — com causa provável, arquivos e histórico.</div>;
  return (
    <div className="copList">
      {incidents.map(i => (
        <div key={i.id} className="copIncident">
          <div className="copIncTop" onClick={() => setOpen(open === i.id ? null : i.id)}>
            <span className="copSev" style={{ background: SEV_COLOR[i.severity] || '#8b96af' }}>{i.severity}</span>
            <span className="copIncTitle">{i.summary}</span>
            <span className="copIncMeta">{i.occurrences > 1 ? `${i.occurrences}×` : ''} {STATUS_LABEL[i.status] || i.status}</span>
          </div>
          {open === i.id && (
            <div className="copIncBody">
              {i.probableCause && <p><b>Causa provável:</b> {i.probableCause}{i.confidence != null && <span className="copConf"> · confiança {i.confidence}%</span>}</p>}
              {Array.isArray(i.relatedFiles) && i.relatedFiles.length > 0 && (
                <p><b>Arquivos:</b> {i.relatedFiles.map(f => `${f.file || f}${f.lines?.length ? ':' + f.lines.join(',') : ''}`).join(' · ')}</p>
              )}
              {i.errorMessage && <pre className="copErr">{i.errorMessage}</pre>}
              {i.project && <p className="copDim">Projeto: {i.project}</p>}
              <div className="copIncActions">
                <a href={`${API}/api/companion/incidents/${encodeURIComponent(i.id)}/report.md`} target="_blank" rel="noreferrer"><FileDown size={13} /> Relatório</a>
                {i.status !== 'investigando' && <button onClick={() => updateIncident(i.id, { status: 'investigando' })}>Investigar</button>}
                {i.status !== 'resolvido' && <button className="ok" onClick={() => updateIncident(i.id, { status: 'resolvido' })}>Marcar resolvido</button>}
                {i.status !== 'ignorado' && <button onClick={() => updateIncident(i.id, { status: 'ignorado' })}>Ignorar</button>}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Bar({ pct, danger }) {
  return <div className="copBar"><span style={{ width: `${Math.min(100, pct || 0)}%`, background: danger ? '#ef4444' : '#4f8cff' }} /></div>;
}

function Health({ health, onReload }) {
  if (!health) return <div className="copEmpty">Carregando métricas… <button className="copLink" onClick={onReload}>recarregar</button></div>;
  const h = health;
  const statusIcon = h.status === 'ok' ? <CheckCircle2 size={16} color="#22c55e" /> : h.status === 'critico' ? <Octagon size={16} color="#ef4444" /> : <AlertTriangle size={16} color="#f0a340" />;
  return (
    <div className="copHealth">
      <div className="copHealthTop">{statusIcon} <b>Estado geral: {h.status === 'ok' ? 'saudável' : h.status === 'critico' ? 'crítico' : 'atenção'}</b>
        <button className="copLink" onClick={onReload}>atualizar</button></div>

      {h.alerts?.length > 0 && (
        <ul className="copAlerts">
          {h.alerts.map((a, k) => <li key={k} className={`lvl-${a.level}`}><AlertTriangle size={13} /> {a.msg}</li>)}
        </ul>
      )}

      <div className="copMetric"><span><MemoryStick size={14} /> Memória (RSS)</span><b>{h.memory.rssMb} MB</b></div>
      <div className="copMetric"><span>Memória do sistema</span><b>{h.memory.systemUsedPct}%</b></div>
      <Bar pct={h.memory.systemUsedPct} danger={h.memory.systemUsedPct >= 90} />
      {h.memory.trend?.leaking && <div className="copWarn">⚠ Possível vazamento: +{h.memory.trend.growthMbPerHour} MB/h</div>}

      <div className="copMetric"><span><Cpu size={14} /> CPU (load 1m)</span><b>{h.cpu.load1} / {h.cpu.cores} núcleos</b></div>
      <div className="copMetric"><span><HardDrive size={14} /> Disco</span><b>{h.disk.freeGb ?? '?'} GB livres{h.disk.usedPct != null ? ` (${h.disk.usedPct}%)` : ''}</b></div>
      {h.disk.usedPct != null && <Bar pct={h.disk.usedPct} danger={h.disk.usedPct >= 90} />}
      <div className="copMetric"><span>Event loop (atraso médio)</span><b>{h.eventLoop.meanMs} ms</b></div>
      <div className="copMetric"><span>Uptime</span><b>{Math.floor(h.uptimeSec / 3600)}h {Math.floor((h.uptimeSec % 3600) / 60)}m</b></div>
      {h.unhandledRejections > 0 && <div className="copWarn">⚠ {h.unhandledRejections} rejeição(ões) não tratada(s) desde o boot</div>}
    </div>
  );
}

function Permissions({ copilot }) {
  const { permissions: p, savePermissions, emergencyStop } = copilot;
  const [busy, setBusy] = useState(false);
  if (!p) return <div className="copEmpty">Carregando permissões…</div>;

  const set = async (patch) => { setBusy(true); await savePermissions({ level: p.level, readOnly: p.readOnly, emergencyStop: p.emergencyStop, grant: p.grant, revoke: p.revoke, allowList: p.allowList, blockList: p.blockList, ...patch }); setBusy(false); };
  const LEVELS = [
    { n: 1, t: 'Somente leitura', d: 'Observa e lê; não executa nada.' },
    { n: 2, t: 'Preparar', d: 'Cria/edita rascunhos; não executa.' },
    { n: 3, t: 'Executar com confirmação', d: 'Roda comandos seguros com sua aprovação.' },
    { n: 4, t: 'Automação limitada', d: 'Deps, serviços e containers pré-autorizados.' },
    { n: 5, t: 'Autonomia avançada', d: 'Ações amplas — sempre com auditoria.' },
  ];

  return (
    <div className="copPerms">
      {p.emergencyStop && <div className="copEmergencyOn">🛑 PARADA DE EMERGÊNCIA ATIVA — nenhuma ação é executada. <button onClick={() => set({ emergencyStop: false })} disabled={busy}>Reativar</button></div>}

      <div className="copPermLabel">Nível de autonomia</div>
      <div className="copLevels">
        {LEVELS.map(l => (
          <button key={l.n} className={`copLevel ${p.level === l.n ? 'on' : ''}`} disabled={busy} onClick={() => set({ level: l.n })}>
            <b>Nível {l.n} — {l.t}</b><span>{l.d}</span>
          </button>
        ))}
      </div>

      <label className="copSwitch"><input type="checkbox" checked={p.readOnly} disabled={busy} onChange={e => set({ readOnly: e.target.checked })} /> Modo somente-leitura (bloqueia qualquer escrita/execução)</label>

      <div className="copPermLabel">Capacidades ativas neste nível</div>
      <div className="copCaps">
        {(p.capabilities || []).map(c => <span key={c} className={`copCap ${p.sensitive?.includes(c) ? 'sens' : ''}`}>{c.replace(/_/g, ' ')}{p.sensitive?.includes(c) ? ' 🔒' : ''}</span>)}
      </div>
      <div className="copDim">🔒 = ação sensível: sempre pede confirmação, mesmo no nível 5.</div>

      <button className="copEmergency" onClick={emergencyStop} disabled={busy || p.emergencyStop}><Octagon size={15} /> Parada de emergência</button>
    </div>
  );
}
