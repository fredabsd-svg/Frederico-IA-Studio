// Apresentação da telemetria local de confiabilidade (Fase 66).
//
// O backend entrega números; aqui decidimos como eles viram texto. Duas
// posições que este módulo defende:
//
//  * **Sem amostra não se afirma nada.** "0% de falha" com zero execução é
//    mentira estatística; a frase precisa dizer que não há dado.
//  * **Corte é declarado.** A lista de ferramentas é limitada na tela, e o que
//    ficou de fora vem contado — o painel nunca dá a impressão de mostrar
//    tudo quando mostra uma parte.

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const min = Math.floor(ms / 60_000);
  const seg = Math.round((ms % 60_000) / 1000);
  return seg ? `${min} min ${seg} s` : `${min} min`;
}

// Top N por falhas, com o restante CONTADO em vez de sumir.
export function topTools(ferramentas = [], limite = 5) {
  const lista = [...ferramentas];
  const mostrados = lista.slice(0, limite);
  const restantes = Math.max(0, lista.length - mostrados.length);
  const chamadasRestantes = lista.slice(limite).reduce((acc, item) => acc + (item.chamadas || 0), 0);
  return { mostrados, restantes, chamadasRestantes };
}

// A frase do cabeçalho. É o que a maioria vai ler — e a única coisa que a
// maioria vai ler.
export function reliabilityHeadline(report) {
  const runs = report?.runs;
  if (!runs || !runs.total) {
    return `Nenhuma execução registrada nos últimos ${report?.janela_dias || 30} dias.`;
  }
  if (runs.taxa_sucesso == null) {
    return `${runs.total} execução(ões) na janela, nenhuma com desfecho ainda.`;
  }
  const partes = [`${runs.taxa_sucesso}% das execuções com desfecho concluíram`];
  if (runs.duracao_ms?.mediana != null) partes.push(`mediana de ${formatDuration(runs.duracao_ms.mediana)}`);
  return `${partes.join(', ')} (${runs.terminais} de ${runs.total} na janela de ${report.janela_dias} dias).`;
}

// Cor/estado do bloco, derivado do pior sinal — sem inventar um nível que
// nenhum sinal declarou.
export function reliabilityTone(report) {
  const niveis = (report?.sinais || []).map(s => s.nivel);
  if (niveis.includes('alto')) return 'warn';
  if (niveis.includes('medio')) return 'attn';
  return 'ok';
}
