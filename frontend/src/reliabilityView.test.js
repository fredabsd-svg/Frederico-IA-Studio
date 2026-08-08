import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDuration, topTools, reliabilityHeadline, reliabilityTone } from './reliabilityView.js';

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

test('o tom vem do pior sinal, e não de um nível inventado', () => {
  assert.equal(reliabilityTone({ sinais: [] }), 'ok');
  assert.equal(reliabilityTone({ sinais: [{ nivel: 'baixo' }] }), 'ok');
  assert.equal(reliabilityTone({ sinais: [{ nivel: 'baixo' }, { nivel: 'medio' }] }), 'attn');
  assert.equal(reliabilityTone({ sinais: [{ nivel: 'medio' }, { nivel: 'alto' }] }), 'warn');
  assert.equal(reliabilityTone(null), 'ok');
});
