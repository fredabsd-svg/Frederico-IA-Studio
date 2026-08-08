import React, { useEffect, useState } from 'react';
import { AlertCircle, Gauge, Info, Loader } from 'lucide-react';
import { API } from '../constants.js';
import { formatDuration, reliabilityHeadline, reliabilityTone, topTools } from '../reliabilityView.js';

// Telemetria LOCAL de confiabilidade (Fase 66).
//
// Responde a pergunta que o painel de consumo não responde: **o trabalho deu
// certo?** Os números saem de `agent_runs`/`agent_run_events`, que o backend já
// grava — não há coleta nova, e nada sai da instalação.
//
// Escopo do projeto quando há um: "como o agente vai NESTE projeto" é mais
// acionável que uma média de tudo.

const GRUPO_LABEL = { sucesso: 'concluíram', falha: 'falharam', interrompido: 'interrompidas', aguardando: 'aguardando você' };

export function ReliabilityPanel({ projectId = null, dias = 30, busy = false }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true }));
    const params = new URLSearchParams({ dias: String(dias) });
    if (projectId) params.set('project', projectId);
    fetch(`${API}/api/reliability?${params}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Não foi possível ler a confiabilidade.'))))
      .then(data => { if (alive) setState({ loading: false, data, error: '' }); })
      .catch(err => { if (alive) setState({ loading: false, data: null, error: err.message }); })
      .finally(() => {});
    return () => { alive = false; };
    // `busy` no fim: ao terminar uma execução, os números mudam.
  }, [projectId, dias, busy]);

  if (state.loading) return <p className="devRailHint"><Loader size={13} className="esSpin"/> Somando as execuções…</p>;
  if (state.error) return <p className="devRailHint">{state.error}</p>;

  const report = state.data;
  const { mostrados, restantes, chamadasRestantes } = topTools(report?.ferramentas?.ferramentas || [], 5);
  const grupos = Object.entries(report?.runs?.por_grupo || {});

  return (
    <div className={`reliability rl-${reliabilityTone(report)}`}>
      <p className="reliabilityHead"><Gauge size={14}/> {reliabilityHeadline(report)}</p>

      {grupos.length > 0 && <ul className="reliabilityGrupos">
        {grupos.map(([grupo, n]) => (
          <li key={grupo}><b>{n}</b> {GRUPO_LABEL[grupo] || grupo}</li>
        ))}
      </ul>}

      {report?.runs?.duracao_ms?.p90 != null && (
        <p className="devRailHint">
          Duração: mediana {formatDuration(report.runs.duracao_ms.mediana)} · 9 em cada 10 abaixo de {formatDuration(report.runs.duracao_ms.p90)}.
        </p>
      )}

      {mostrados.length > 0 && <>
        <h5 className="reliabilityTitle">Ferramentas</h5>
        <ul className="reliabilityTools">
          {mostrados.map(item => (
            <li key={item.ferramenta}>
              <code>{item.ferramenta}</code>
              <span className="reliabilityBar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, item.taxa_falha || 0)}%` }}/>
              </span>
              <small>{item.falhas}/{item.chamadas} falharam{item.taxa_falha != null ? ` (${item.taxa_falha}%)` : ''}</small>
            </li>
          ))}
        </ul>
        {restantes > 0 && (
          <p className="devRailHint">+{restantes} outra(s) ferramenta(s), {chamadasRestantes} chamada(s), sem falha relevante.</p>
        )}
      </>}

      {(report?.sinais || []).length > 0 && <>
        <h5 className="reliabilityTitle">Sinais</h5>
        <ul className="reliabilitySinais">
          {report.sinais.map((sinal, i) => (
            <li key={i} className={`rl-${sinal.nivel}`}>
              {sinal.nivel === 'baixo' ? <Info size={13}/> : <AlertCircle size={13}/>}
              <span>{sinal.texto}</span>
            </li>
          ))}
        </ul>
      </>}

      <p className="devRailHint">
        {report?.amostra?.truncado
          ? `Amostra limitada: ${report.amostra.runs} execuções mais recentes (teto ${report.amostra.teto_runs}). Os números descrevem essa fatia.`
          : `Amostra: ${report?.amostra?.runs || 0} execução(ões) desta conta${projectId ? ' neste projeto' : ''}. Nada sai desta instalação.`}
      </p>
    </div>
  );
}
