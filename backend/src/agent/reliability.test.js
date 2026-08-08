// Telemetria local de confiabilidade (Fase 66). A agregação é pura de
// propósito — estes testes rodam sem PostgreSQL e cobrem a parte que decide.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OUTCOME_GROUPS, summarizeRuns, summarizeToolEvents, reliabilitySignals,
  reliabilityReport, MIN_RUNS_PARA_SINAL, MAX_RUNS,
  bucketRuns, trendFromRuns, TENDENCIA_DELTA_MIN
} from './reliability.js';

const run = (state, ms = 1000, id = Math.random().toString(36).slice(2)) => ({
  run_id: id,
  state,
  started_at: new Date(Date.UTC(2026, 7, 1, 12, 0, 0)).toISOString(),
  ended_at: new Date(Date.UTC(2026, 7, 1, 12, 0, 0) + ms).toISOString()
});
const start = (runId, id, name) => ({ run_id: runId, type: 'tool_start', payload: { id, name } });
const result = (runId, id, content) => ({ run_id: runId, type: 'tool_result', payload: { id, content } });

// ── desfecho dos runs ───────────────────────────────────────────────────────

test('espera pelo usuário NÃO é falha nem sucesso', () => {
  // É a decisão que define o número que todo mundo vai olhar: contar
  // awaiting_user como falha inflaria o problema; como sucesso, o esconderia.
  assert.equal(OUTCOME_GROUPS.awaiting_user, 'aguardando');
  assert.equal(OUTCOME_GROUPS.paused, 'aguardando');
  const s = summarizeRuns([run('completed'), run('awaiting_user'), run('paused')]);
  assert.equal(s.taxa_sucesso, 100, 'só o completed entra no denominador');
  assert.equal(s.por_grupo.aguardando, 2);
});

test('taxa de sucesso e de falha saem do mesmo denominador', () => {
  const s = summarizeRuns([
    run('completed'), run('completed'), run('completed'),
    run('fatal_error'), run('recoverable_error')
  ]);
  assert.equal(s.terminais, 5);
  assert.equal(s.taxa_sucesso, 60);
  assert.equal(s.taxa_falha, 40);
  assert.equal(s.por_grupo.falha, 2);
});

test('run em estado não terminal conta como em andamento, fora das taxas', () => {
  const s = summarizeRuns([run('completed'), run('tool_running'), run('planning')]);
  assert.equal(s.em_andamento, 2);
  assert.equal(s.terminais, 1);
  assert.equal(s.taxa_sucesso, 100);
});

test('duração só entra com início e fim válidos, e o p90 é o topo', () => {
  const s = summarizeRuns([
    run('completed', 1000), run('completed', 2000), run('completed', 3000),
    run('completed', 4000), run('completed', 100000),
    // Sem ended_at: um run aberto mediria o relógio, não o trabalho.
    { run_id: 'x', state: 'completed', started_at: new Date().toISOString(), ended_at: null }
  ]);
  assert.equal(s.duracao_ms.amostra, 5);
  assert.equal(s.duracao_ms.mediana, 3000);
  assert.equal(s.duracao_ms.p90, 100000);
});

test('lista vazia não inventa taxa (null, não zero)', () => {
  const s = summarizeRuns([]);
  assert.equal(s.total, 0);
  assert.equal(s.taxa_sucesso, null);
  assert.equal(s.duracao_ms.mediana, null);
});

// ── ferramentas ─────────────────────────────────────────────────────────────

test('falha de ferramenta usa o MESMO critério do terminal', () => {
  const eventos = [
    start('r1', 'a', 'bash'), result('r1', 'a', JSON.stringify({ exitCode: 1, output: 'erro' })),
    start('r1', 'b', 'bash'), result('r1', 'b', JSON.stringify({ exitCode: 0, output: 'ok' })),
    start('r1', 'c', 'read_file'), result('r1', 'c', JSON.stringify({ error: 'não existe' })),
    start('r1', 'd', 'read_file'), result('r1', 'd', JSON.stringify({ path: 'a.js', content: 'x' }))
  ];
  const t = summarizeToolEvents(eventos, { runFinalStates: new Map([['r1', 'completed']]) });
  const bash = t.ferramentas.find(f => f.ferramenta === 'bash');
  assert.equal(bash.chamadas, 2);
  assert.equal(bash.falhas, 1);
  assert.equal(bash.taxa_falha, 50);
  assert.equal(t.total_chamadas, 4);
  assert.equal(t.total_falhas, 2);
});

test('texto solto no resultado não é falha', () => {
  const t = summarizeToolEvents([start('r1', 'a', 'bash'), result('r1', 'a', 'saída qualquer')],
    { runFinalStates: new Map([['r1', 'completed']]) });
  assert.equal(t.total_falhas, 0);
});

test('chamada sem resultado só conta quando o run NÃO concluiu', () => {
  const eventos = [start('r1', 'a', 'bash'), start('r2', 'b', 'bash')];
  const t = summarizeToolEvents(eventos, {
    runFinalStates: new Map([['r1', 'completed'], ['r2', 'fatal_error']])
  });
  // Num run concluído o resultado existiu — é o mesmo critério do
  // stepsFromRunEvents, e contar aqui criaria uma falha que a tela não mostra.
  assert.equal(t.total_sem_resultado, 1);
  assert.equal(t.ferramentas.find(f => f.ferramenta === 'bash').sem_resultado, 1);
});

test('ids de chamada iguais em runs diferentes não se confundem', () => {
  const eventos = [
    start('r1', 'call_1', 'bash'), start('r2', 'call_1', 'read_file'),
    result('r2', 'call_1', JSON.stringify({ error: 'x' })),
    result('r1', 'call_1', JSON.stringify({ exitCode: 0 }))
  ];
  const t = summarizeToolEvents(eventos, { runFinalStates: new Map([['r1', 'completed'], ['r2', 'completed']]) });
  assert.equal(t.ferramentas.find(f => f.ferramenta === 'bash').falhas, 0);
  assert.equal(t.ferramentas.find(f => f.ferramenta === 'read_file').falhas, 1);
});

test('resultado órfão (sem start) é ignorado em vez de virar ferramenta fantasma', () => {
  const t = summarizeToolEvents([result('r1', 'zz', JSON.stringify({ error: 'x' }))], {});
  assert.deepEqual(t.ferramentas, []);
});

// ── sinais ──────────────────────────────────────────────────────────────────

test('sinal não aparece sem amostra — 100% de falha em 1 execução é ruído', () => {
  const runs = summarizeRuns([run('fatal_error')]);
  const tools = summarizeToolEvents([start('r1', 'a', 'bash'), result('r1', 'a', JSON.stringify({ error: 'x' }))],
    { runFinalStates: new Map([['r1', 'fatal_error']]) });
  assert.equal(runs.taxa_falha, 100);
  const sinais = reliabilitySignals(runs, tools);
  assert.equal(sinais.filter(s => /execuções com desfecho/.test(s.texto)).length, 0);
  assert.equal(sinais.filter(s => /ferramenta "bash"/.test(s.texto)).length, 0);
});

test('com amostra suficiente o sinal aparece e CITA os números', () => {
  const rows = [...Array(MIN_RUNS_PARA_SINAL).keys()].map(i => run(i < 2 ? 'fatal_error' : 'completed'));
  const runs = summarizeRuns(rows);
  const sinais = reliabilitySignals(runs, { ferramentas: [], total_sem_resultado: 0 });
  const alvo = sinais.find(s => /execuções com desfecho/.test(s.texto));
  assert.ok(alvo, 'o sinal precisa existir');
  assert.equal(alvo.nivel, 'alto');
  assert.match(alvo.texto, /40% .*\(2 de 5\)/);
});

test('ferramenta muito ruim sobe de nível, e a menos ruim não', () => {
  const tools = {
    ferramentas: [
      { ferramenta: 'bash', chamadas: 10, falhas: 7, taxa_falha: 70 },
      { ferramenta: 'read_file', chamadas: 10, falhas: 4, taxa_falha: 40 },
      { ferramenta: 'web_fetch', chamadas: 10, falhas: 1, taxa_falha: 10 }
    ],
    total_sem_resultado: 0
  };
  const sinais = reliabilitySignals(summarizeRuns([]), tools);
  assert.equal(sinais.find(s => /"bash"/.test(s.texto)).nivel, 'alto');
  assert.equal(sinais.find(s => /"read_file"/.test(s.texto)).nivel, 'medio');
  assert.equal(sinais.filter(s => /"web_fetch"/.test(s.texto)).length, 0);
});

// ── relatório ───────────────────────────────────────────────────────────────

test('o relatório declara a amostra e o corte, em vez de cortar calado', () => {
  const r = reliabilityReport({
    runRows: [run('completed')],
    eventRows: [start('r1', 'a', 'bash')],
    janelaDias: 7,
    truncado: true
  });
  assert.equal(r.janela_dias, 7);
  assert.equal(r.amostra.runs, 1);
  assert.equal(r.amostra.eventos, 1);
  assert.equal(r.amostra.truncado, true);
  assert.equal(r.amostra.teto_runs, MAX_RUNS);
});

test('relatório vazio é honesto: zero amostra, nenhum sinal, nenhuma taxa', () => {
  const r = reliabilityReport({ janelaDias: 30 });
  assert.equal(r.amostra.runs, 0);
  assert.deepEqual(r.sinais, []);
  assert.equal(r.runs.taxa_sucesso, null);
  assert.deepEqual(r.ferramentas.ferramentas, []);
});

// ── série temporal ──────────────────────────────────────────────────────────

const AGORA = Date.UTC(2026, 7, 8, 12, 0, 0);
const DIA = 86_400_000;
// Run posicionado a N dias atrás.
const runEm = (state, diasAtras, id = `${state}-${diasAtras}-${Math.random()}`) => ({
  run_id: id,
  state,
  started_at: new Date(AGORA - diasAtras * DIA).toISOString(),
  ended_at: new Date(AGORA - diasAtras * DIA + 1000).toISOString()
});

test('janela curta é lida por dia; janela longa, por semana', () => {
  assert.equal(bucketRuns([], { janelaDias: 7, agora: AGORA }).passo, 'dia');
  assert.equal(bucketRuns([], { janelaDias: 30, agora: AGORA }).passo, 'semana');
  assert.equal(bucketRuns([], { janelaDias: 7, agora: AGORA }).pontos.length, 7);
});

// Sumir com o balde vazio juntaria duas semanas separadas como se fossem
// vizinhas — o eixo do tempo deixaria de ser tempo.
test('balde sem execução aparece com zero, não some', () => {
  const { pontos } = bucketRuns([runEm('completed', 0)], { janelaDias: 7, agora: AGORA });
  assert.equal(pontos.length, 7);
  assert.equal(pontos.at(-1).total, 1);
  assert.equal(pontos[0].total, 0);
  assert.equal(pontos[0].taxa_sucesso, null, 'balde vazio não tem taxa');
});

test('cada balde calcula a própria taxa, e run fora da janela fica de fora', () => {
  const rows = [
    runEm('completed', 2), runEm('completed', 2), runEm('fatal_error', 2),
    runEm('completed', 99)   // fora da janela de 7 dias
  ];
  const { pontos } = bucketRuns(rows, { janelaDias: 7, agora: AGORA });
  const anteontem = pontos.at(-2);   // baldes de 1 dia: 2 dias atrás é o penúltimo
  assert.equal(anteontem.total, 3);
  assert.equal(anteontem.taxa_sucesso, 66.7);
  assert.equal(pontos.reduce((acc, p) => acc + p.total, 0), 3, 'o run antigo não entra em balde nenhum');
});

test('a tendência NÃO se pronuncia sem amostra nas duas metades', () => {
  // 20 execuções recentes contra 2 antigas não é tendência, é acaso.
  const rows = [
    ...Array.from({ length: 20 }, () => runEm('completed', 2)),
    runEm('fatal_error', 25), runEm('fatal_error', 26)
  ];
  const t = trendFromRuns(rows, { janelaDias: 30, agora: AGORA });
  assert.equal(t.tendencia, 'sem_amostra');
  assert.equal(t.delta, null);
  // E diz POR QUE, para a ausência não ser lida como "tudo bem".
  assert.match(t.motivo, /ao menos 5 execuções/);
});

test('diferença abaixo do piso é ESTÁVEL, não "melhorou"', () => {
  // Antiga: 8/10 = 80%. Recente: 17/20 = 85%. Delta 5 < 10 → estável.
  const rows = [
    ...Array.from({ length: 8 }, () => runEm('completed', 25)),
    ...Array.from({ length: 2 }, () => runEm('fatal_error', 25)),
    ...Array.from({ length: 17 }, () => runEm('completed', 5)),
    ...Array.from({ length: 3 }, () => runEm('fatal_error', 5))
  ];
  const t = trendFromRuns(rows, { janelaDias: 30, agora: AGORA });
  assert.equal(t.tendencia, 'estavel');
  assert.ok(Math.abs(t.delta) < TENDENCIA_DELTA_MIN);
});

test('queda real é PIORA, com as duas taxas no resultado', () => {
  const rows = [
    ...Array.from({ length: 9 }, () => runEm('completed', 25)),
    runEm('fatal_error', 25),                                    // antiga: 90%
    ...Array.from({ length: 5 }, () => runEm('completed', 3)),
    ...Array.from({ length: 5 }, () => runEm('fatal_error', 3))   // recente: 50%
  ];
  const t = trendFromRuns(rows, { janelaDias: 30, agora: AGORA });
  assert.equal(t.tendencia, 'piorou');
  assert.equal(t.anterior.taxa_sucesso, 90);
  assert.equal(t.recente.taxa_sucesso, 50);
  assert.equal(t.delta, -40);
});

test('subida real é MELHORA', () => {
  const rows = [
    ...Array.from({ length: 5 }, () => runEm('completed', 25)),
    ...Array.from({ length: 5 }, () => runEm('fatal_error', 25)),  // 50%
    ...Array.from({ length: 9 }, () => runEm('completed', 3)),
    runEm('fatal_error', 3)                                        // 90%
  ];
  assert.equal(trendFromRuns(rows, { janelaDias: 30, agora: AGORA }).tendencia, 'melhorou');
});

test('piora vira sinal, e uma queda grande sobe de nível', () => {
  const leve = reliabilitySignals(summarizeRuns([]), { ferramentas: [], total_sem_resultado: 0 },
    { tendencia: 'piorou', delta: -12, anterior: { taxa_sucesso: 90 }, recente: { taxa_sucesso: 78 } });
  assert.equal(leve[0].nivel, 'medio');
  assert.match(leve[0].texto, /90% → 78%/);

  const grave = reliabilitySignals(summarizeRuns([]), { ferramentas: [], total_sem_resultado: 0 },
    { tendencia: 'piorou', delta: -40, anterior: { taxa_sucesso: 90 }, recente: { taxa_sucesso: 50 } });
  assert.equal(grave[0].nivel, 'alto');
});

// Painel que só reclama é painel que ninguém abre duas vezes.
test('melhora também é dita, em nível baixo', () => {
  const sinais = reliabilitySignals(summarizeRuns([]), { ferramentas: [], total_sem_resultado: 0 },
    { tendencia: 'melhorou', delta: 30, anterior: { taxa_sucesso: 55 }, recente: { taxa_sucesso: 85 } });
  assert.equal(sinais[0].nivel, 'baixo');
  assert.match(sinais[0].texto, /subiu 30 pontos/);
});

test('estável e sem_amostra não viram sinal nenhum', () => {
  const vazio = { ferramentas: [], total_sem_resultado: 0 };
  assert.deepEqual(reliabilitySignals(summarizeRuns([]), vazio, { tendencia: 'estavel', delta: 2 }), []);
  assert.deepEqual(reliabilitySignals(summarizeRuns([]), vazio, { tendencia: 'sem_amostra', delta: null }), []);
  assert.deepEqual(reliabilitySignals(summarizeRuns([]), vazio, null), []);
});

test('o relatório carrega série e tendência, e marca a série truncada', () => {
  const r = reliabilityReport({
    runRows: [runEm('completed', 1)],
    janelaDias: 7,
    truncado: true,
    agora: AGORA
  });
  assert.equal(r.serie.passo, 'dia');
  assert.equal(r.serie.pontos.length, 7);
  // Com amostra no teto, o balde mais antigo fica parcial — o painel precisa
  // saber disso para não ler o volume dele como volume real.
  assert.equal(r.serie.truncada, true);
  assert.equal(r.tendencia.tendencia, 'sem_amostra');
});

test('o relatório liga run e evento: sem resultado num run que falhou vira sinal', () => {
  const r = reliabilityReport({
    runRows: [run('fatal_error', 1000, 'r1')],
    eventRows: [start('r1', 'a', 'bash')]
  });
  assert.equal(r.ferramentas.total_sem_resultado, 1);
  assert.ok(r.sinais.some(s => /sem resultado/.test(s.texto)));
});
