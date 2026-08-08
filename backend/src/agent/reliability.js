// Telemetria LOCAL de confiabilidade (Fase 66 do Developer Workspace 3.0).
//
// A Frente 14 já mede CONSUMO (tokens, custo, feature) no painel admin. O que
// faltava é outra pergunta, e mais desconfortável: **o trabalho deu certo?**
// Uma execução pode consumir tokens exemplarmente e terminar em
// `fatal_error` — no painel de consumo ela some no meio da média.
//
// LOCAL tem sentido literal aqui: nada é enviado a lugar nenhum e nada novo é
// coletado. Tudo sai do que a Fase 17 já persiste (`agent_runs` e
// `agent_run_events`, migration 032). Esta fase é leitura e agregação, não
// instrumentação nova — por isso não há migration.
//
// Duas regras que moldam o módulo:
//
//  1. **Agregação pura, banco fino.** Toda a decisão mora em funções que
//     recebem linhas e devolvem números, testáveis sem PostgreSQL. O coletor
//     só busca e delega — é o mesmo arranjo que deixou o ChangeSet e o review
//     gate testáveis fora do Docker.
//  2. **Corte declarado, nunca silencioso.** A amostra é limitada (event log
//     de 30 dias não cabe em memória num uso pesado), e o resultado DIZ quantos
//     runs entraram e se bateu no teto. Um painel que corta em silêncio conta
//     uma história falsa com números verdadeiros.
import { db } from '../db.js';
import { toolResultLooksFailed } from './runLog.js';

// Desfechos terminais, agrupados pelo que significam para quem lê.
// `awaiting_user` e `paused` NÃO são falha nem sucesso: a execução parou
// porque foi ASSIM que ela deveria parar. Contá-los como falha inflaria o
// problema; como sucesso, o esconderia.
export const OUTCOME_GROUPS = Object.freeze({
  completed: 'sucesso',
  stopped: 'interrompido',
  paused: 'aguardando',
  awaiting_user: 'aguardando',
  recoverable_error: 'falha',
  fatal_error: 'falha'
});

export const MAX_RUNS = 300;
export const MAX_EVENTS = 20_000;

function percentil(valoresOrdenados, p) {
  if (!valoresOrdenados.length) return null;
  const idx = Math.min(valoresOrdenados.length - 1, Math.max(0, Math.ceil((p / 100) * valoresOrdenados.length) - 1));
  return valoresOrdenados[idx];
}

function taxa(parte, total) {
  return total > 0 ? Math.round((parte / total) * 1000) / 10 : null;   // uma casa decimal
}

// ── Runs: desfecho e duração ────────────────────────────────────────────────

export function summarizeRuns(rows = []) {
  const porEstado = new Map();
  const porGrupo = new Map();
  const duracoes = [];
  let emAndamento = 0;

  for (const row of rows) {
    const estado = String(row?.state || '');
    porEstado.set(estado, (porEstado.get(estado) || 0) + 1);
    const grupo = OUTCOME_GROUPS[estado];
    if (!grupo) { emAndamento += 1; continue; }          // estado não terminal
    porGrupo.set(grupo, (porGrupo.get(grupo) || 0) + 1);
    // Duração só de run que TERMINOU: um run aberto mediria o relógio, não o
    // trabalho.
    const inicio = Date.parse(row?.started_at || '');
    const fim = Date.parse(row?.ended_at || '');
    if (Number.isFinite(inicio) && Number.isFinite(fim) && fim >= inicio) duracoes.push(fim - inicio);
  }

  duracoes.sort((a, b) => a - b);
  const terminais = [...porGrupo.values()].reduce((a, b) => a + b, 0);
  const sucesso = porGrupo.get('sucesso') || 0;
  const falha = porGrupo.get('falha') || 0;

  return {
    total: rows.length,
    terminais,
    em_andamento: emAndamento,
    por_estado: Object.fromEntries([...porEstado.entries()].sort((a, b) => b[1] - a[1])),
    por_grupo: Object.fromEntries([...porGrupo.entries()].sort((a, b) => b[1] - a[1])),
    // A taxa de sucesso ignora o que está em andamento e o que espera o
    // usuário — o denominador é o que de fato teve desfecho de máquina.
    taxa_sucesso: taxa(sucesso, sucesso + falha + (porGrupo.get('interrompido') || 0)),
    taxa_falha: taxa(falha, sucesso + falha + (porGrupo.get('interrompido') || 0)),
    duracao_ms: {
      mediana: percentil(duracoes, 50),
      p90: percentil(duracoes, 90),
      amostra: duracoes.length
    }
  };
}

// ── Ferramentas: o que falha, e quanto ──────────────────────────────────────
//
// Reusa `toolResultLooksFailed` do runLog — a MESMA função que decide se uma
// etapa aparece vermelha no terminal. Se a telemetria usasse outro critério,
// o painel e a tela discordariam sobre o mesmo fato.
export function summarizeToolEvents(events = [], { runFinalStates = new Map() } = {}) {
  const abertas = new Map();     // id da chamada → { name, runId }
  const porFerramenta = new Map();
  let semResultado = 0;

  const bump = (nome, campo) => {
    if (!porFerramenta.has(nome)) porFerramenta.set(nome, { ferramenta: nome, chamadas: 0, falhas: 0, sem_resultado: 0 });
    porFerramenta.get(nome)[campo] += 1;
  };

  for (const record of events) {
    const payload = record?.payload || {};
    if (record?.type === 'tool_start') {
      const nome = String(payload.name || 'desconhecida');
      bump(nome, 'chamadas');
      if (payload.id) abertas.set(`${record.run_id}|${payload.id}`, nome);
    } else if (record?.type === 'tool_result') {
      const chave = `${record.run_id}|${payload.id}`;
      const nome = abertas.get(chave);
      if (!nome) continue;                                // resultado órfão
      abertas.delete(chave);
      if (toolResultLooksFailed(payload.content)) bump(nome, 'falhas');
    }
  }

  // Chamada sem resultado: ou o run foi interrompido, ou a ferramenta nunca
  // voltou. Só conta como "sem resultado" quando o run NÃO concluiu — num run
  // concluído o resultado existiu (é o mesmo critério do stepsFromRunEvents).
  for (const [chave, nome] of abertas) {
    const runId = chave.split('|')[0];
    if (runFinalStates.get(runId) === 'completed') continue;
    bump(nome, 'sem_resultado');
    semResultado += 1;
  }

  const lista = [...porFerramenta.values()]
    .map(item => ({ ...item, taxa_falha: taxa(item.falhas, item.chamadas) }))
    .sort((a, b) => (b.falhas - a.falhas) || (b.chamadas - a.chamadas));

  return {
    ferramentas: lista,
    total_chamadas: lista.reduce((acc, item) => acc + item.chamadas, 0),
    total_falhas: lista.reduce((acc, item) => acc + item.falhas, 0),
    total_sem_resultado: semResultado
  };
}

// ── Sinais: o que os números querem dizer ───────────────────────────────────
//
// Mesma disciplina do review gate: cada sinal cita o NÚMERO que o produziu, e
// nenhum é opinião do modelo. Sem amostra suficiente, o sinal não aparece —
// "100% de falha em 1 execução" é ruído travestido de alarme.
export const MIN_RUNS_PARA_SINAL = 5;
export const MIN_CHAMADAS_PARA_SINAL = 5;

export function reliabilitySignals(runs, tools) {
  const sinais = [];
  if (runs.terminais >= MIN_RUNS_PARA_SINAL && runs.taxa_falha != null && runs.taxa_falha >= 20) {
    sinais.push({
      nivel: 'alto',
      texto: `${runs.taxa_falha}% das execuções com desfecho terminaram em erro (${runs.por_grupo.falha || 0} de ${runs.terminais}).`
    });
  }
  for (const item of tools.ferramentas) {
    if (item.chamadas >= MIN_CHAMADAS_PARA_SINAL && item.taxa_falha != null && item.taxa_falha >= 30) {
      sinais.push({
        nivel: item.taxa_falha >= 60 ? 'alto' : 'medio',
        texto: `A ferramenta "${item.ferramenta}" falhou em ${item.taxa_falha}% das chamadas (${item.falhas} de ${item.chamadas}).`
      });
    }
  }
  if (tools.total_sem_resultado > 0) {
    sinais.push({
      nivel: 'medio',
      texto: `${tools.total_sem_resultado} chamada(s) de ferramenta ficaram sem resultado em execuções que não concluíram — sinal de interrupção no meio do trabalho.`
    });
  }
  if (runs.em_andamento > 0) {
    sinais.push({
      nivel: 'baixo',
      texto: `${runs.em_andamento} execução(ões) sem estado terminal na janela — em andamento agora, ou órfãs de um reinício.`
    });
  }
  return sinais;
}

export function reliabilityReport({ runRows = [], eventRows = [], janelaDias = 30, truncado = false } = {}) {
  const runs = summarizeRuns(runRows);
  const runFinalStates = new Map(runRows.map(row => [row.run_id, row.state]));
  const tools = summarizeToolEvents(eventRows, { runFinalStates });
  return {
    janela_dias: janelaDias,
    amostra: {
      runs: runRows.length,
      eventos: eventRows.length,
      // Corte DECLARADO: quem lê precisa saber que está vendo uma fatia.
      truncado,
      teto_runs: MAX_RUNS,
      teto_eventos: MAX_EVENTS
    },
    runs,
    ferramentas: tools,
    sinais: reliabilitySignals(runs, tools)
  };
}

// ── Coletor (fino, é só busca) ──────────────────────────────────────────────

function desdeIso(dias) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(1, Math.min(365, Number(dias) || 30)));
  return d.toISOString();
}

export async function collectReliability(userId, { dias = 30, conversationIds = null } = {}) {
  const janelaDias = Math.max(1, Math.min(365, Number(dias) || 30));
  const desde = desdeIso(janelaDias);
  let runRows = [];
  try {
    if (Array.isArray(conversationIds)) {
      if (!conversationIds.length) return reliabilityReport({ janelaDias });
      const marcadores = conversationIds.map(() => '?').join(',');
      runRows = await db.prepare(`
        SELECT run_id, state, started_at, ended_at FROM agent_runs
        WHERE user_id=? AND started_at>=? AND conversation_id IN (${marcadores})
        ORDER BY started_at DESC LIMIT ?
      `).all(userId, desde, ...conversationIds, MAX_RUNS);
    } else {
      runRows = await db.prepare(`
        SELECT run_id, state, started_at, ended_at FROM agent_runs
        WHERE user_id=? AND started_at>=?
        ORDER BY started_at DESC LIMIT ?
      `).all(userId, desde, MAX_RUNS);
    }
  } catch (err) {
    console.error('[confiabilidade] leitura de runs falhou:', err.message);
    return reliabilityReport({ janelaDias });
  }
  if (!runRows.length) return reliabilityReport({ janelaDias });

  // O payload é JSON em TEXT, então a falha por ferramenta não dá para agregar
  // em SQL de forma portátil entre SQLite e Postgres: buscamos só os dois tipos
  // que interessam, com teto.
  let eventRows = [];
  try {
    const marcadores = runRows.map(() => '?').join(',');
    const rows = await db.prepare(`
      SELECT run_id, type, payload FROM agent_run_events
      WHERE run_id IN (${marcadores}) AND type IN ('tool_start','tool_result')
      ORDER BY run_id, seq LIMIT ?
    `).all(...runRows.map(row => row.run_id), MAX_EVENTS);
    eventRows = rows.map(row => {
      let payload = {};
      try { payload = JSON.parse(row.payload); } catch { /* evento ilegível não vira falha */ }
      return { run_id: row.run_id, type: row.type, payload };
    });
  } catch (err) {
    console.error('[confiabilidade] leitura de eventos falhou:', err.message);
  }

  return reliabilityReport({
    runRows,
    eventRows,
    janelaDias,
    truncado: runRows.length >= MAX_RUNS || eventRows.length >= MAX_EVENTS
  });
}
