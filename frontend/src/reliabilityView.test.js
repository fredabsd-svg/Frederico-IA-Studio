import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDuration, topTools, reliabilityHeadline, reliabilityTone, trendSentence, sparklinePoints } from './reliabilityView.js';

test('formatDuration usa a unidade que cabe, com vírgula decimal', () => {
  assert.equal(formatDuration(820), '820 ms');
  assert.equal(formatDuration(1234), '1,2 s');
  assert.equal(formatDuration(65_000), '1 min 5 s');
  assert.equal(formatDuration(120_000), '2 min');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(undefined), '—');
});

test('topTools conta o que ficou de fora em vez de cortar calado', () => {
  const lista = Array.from({ length: 8 }, (_, i) => ({ ferramenta: `f${i}`, chamadas: 10, falhas: 8 - i }));
  const { mostrados, restantes, chamadasRestantes } = topTools(lista, 5);
  assert.equal(mostrados.length, 5);
  assert.equal(restantes, 3);
  assert.equal(chamadasRestantes, 30);
});

test('topTools com lista curta não inventa resto', () => {
  const { mostrados, restantes } = topTools([{ ferramenta: 'bash', chamadas: 2, falhas: 0 }], 5);
  assert.equal(mostrados.length, 1);
  assert.equal(restantes, 0);
});

// Sem amostra não se afirma nada — "0% de falha" com zero execução é mentira
// estatística, e é justamente o estado em que a maioria vai abrir o painel.
test('sem execução a frase diz isso, e não uma taxa', () => {
  const texto = reliabilityHeadline({ janela_dias: 30, runs: { total: 0, taxa_sucesso: null } });
  assert.match(texto, /Nenhuma execução registrada/);
  assert.doesNotMatch(texto, /%/);
});

test('com execuções sem desfecho, a frase não vira taxa', () => {
  const texto = reliabilityHeadline({ janela_dias: 7, runs: { total: 3, terminais: 0, taxa_sucesso: null } });
  assert.match(texto, /nenhuma com desfecho ainda/);
});

test('a frase cita taxa, mediana e o tamanho da amostra', () => {
  const texto = reliabilityHeadline({
    janela_dias: 30,
    runs: { total: 12, terminais: 10, taxa_sucesso: 80, duracao_ms: { mediana: 45_000 } }
  });
  assert.match(texto, /80% das execuções/);
  assert.match(texto, /45,0 s/);
  assert.match(texto, /10 de 12/);
});

// A ausência de tendência precisa DIZER que é ausência: silêncio seria lido
// como "está tudo igual".
test('sem amostra, a frase da tendência explica o motivo em vez de calar', () => {
  const texto = trendSentence({ tendencia: 'sem_amostra', motivo: 'São necessárias ao menos 5 execuções em cada metade.' });
  assert.match(texto, /Sem base para comparar/);
  assert.match(texto, /ao menos 5 execuções/);
  assert.equal(trendSentence(null), '');
});

test('a frase distingue estável, melhora e piora, sempre com as duas taxas', () => {
  const base = { anterior: { taxa_sucesso: 90 }, recente: { taxa_sucesso: 50 } };
  assert.match(trendSentence({ ...base, tendencia: 'piorou', delta: -40 }), /caiu 40 pontos .*90% → 50%/);
  assert.match(trendSentence({ tendencia: 'melhorou', delta: 30, anterior: { taxa_sucesso: 55 }, recente: { taxa_sucesso: 85 } }), /subiu 30 pontos/);
  assert.match(trendSentence({ tendencia: 'estavel', delta: 2, anterior: { taxa_sucesso: 80 }, recente: { taxa_sucesso: 82 } }), /Estável.*80% → 82%/);
});

test('o minigráfico mantém o balde vazio como marca rasa, não o descarta', () => {
  const pontos = sparklinePoints({
    pontos: [
      { de: '2026-08-01T00:00:00.000Z', total: 0, taxa_sucesso: null },
      { de: '2026-08-02T00:00:00.000Z', total: 4, taxa_sucesso: 75 },
      { de: '2026-08-03T00:00:00.000Z', total: 2, taxa_sucesso: 0 }
    ]
  });
  assert.equal(pontos.length, 3, 'nenhum ponto some — o eixo é tempo');
  assert.equal(pontos[0].vazio, true);
  assert.equal(pontos[0].altura, 4, 'vazio vira marca rasa');
  assert.match(pontos[0].titulo, /nenhuma execução/);
  assert.equal(pontos[1].altura, 75);
  // 0% de sucesso também precisa ser visível: altura zero sumiria da tela.
  assert.equal(pontos[2].altura, 4);
  assert.match(pontos[2].titulo, /0% de sucesso/);
});

test('série ausente não quebra o minigráfico', () => {
  assert.deepEqual(sparklinePoints(null), []);
  assert.deepEqual(sparklinePoints({}), []);
});

test('o tom vem do pior sinal, e não de um nível inventado', () => {
  assert.equal(reliabilityTone({ sinais: [] }), 'ok');
  assert.equal(reliabilityTone({ sinais: [{ nivel: 'baixo' }] }), 'ok');
  assert.equal(reliabilityTone({ sinais: [{ nivel: 'baixo' }, { nivel: 'medio' }] }), 'attn');
  assert.equal(reliabilityTone({ sinais: [{ nivel: 'medio' }, { nivel: 'alto' }] }), 'warn');
  assert.equal(reliabilityTone(null), 'ok');
});
