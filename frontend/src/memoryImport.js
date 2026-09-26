// Resumo da importação de memória — PURO (testável).
//
// No modo gratuito (ou sem chave própria) a importação salva só os trechos:
// extrair fatos exige um modelo, e a chave da plataforma não é gasta nisso. O
// backend diz o porquê em `factsSkipped`, mas a tela mostrava "0 fatos
// aprendidos" como se a extração tivesse rodado e não achado nada.
const MOTIVO_SEM_FATOS = {
  free_mode: 'fatos não extraídos no modo gratuito — cadastre uma chave de IA para extraí-los',
  no_provider: 'fatos não extraídos: nenhuma chave de IA configurada'
};

export function importFactsLabel(status) {
  const motivo = MOTIVO_SEM_FATOS[status?.factsSkipped];
  if (motivo) return motivo;
  return `${Number(status?.facts) || 0} fatos aprendidos`;
}

export function importProgressLabel(status) {
  const s = status || {};
  return `Importando "${s.file}": conversa ${s.processed} de ${s.total} · ${s.chunks} trechos · ${importFactsLabel(s)}...`;
}

export function importDoneLabel(status) {
  const s = status || {};
  return `Importado: ${s.total} conversa(s), ${s.chunks} trechos indexados, ${importFactsLabel(s)}.`;
}
