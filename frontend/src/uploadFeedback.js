// Mensagens de recusa de upload — módulo puro (sem React, sem import.meta.env),
// para ser testável fora do bundler.
//
// O backend passou a recusar envios por motivos distintos (total do lote acima do
// teto, cota do usuário, envios simultâneos demais, antivírus obrigatório fora do
// ar). Antes, qualquer falha virava "Verifique o tamanho (máx. 50 MB)" — o que
// mandava o usuário diminuir o arquivo errado.
export function uploadErrorFor(status) {
  if (status === 413) return 'O envio passou do limite de tamanho permitido. Envie os arquivos em lotes menores.';
  if (status === 429) return 'Há envios demais em andamento. Aguarde os atuais terminarem e tente de novo.';
  if (status === 503) return 'O antivírus está indisponível e a verificação é obrigatória nesta instalação. Tente novamente em alguns minutos.';
  if (status === 404) return 'Conversa não encontrada.';
  return 'Falha no envio do arquivo. Verifique o tamanho e tente de novo.';
}

// Texto do aviso quando o lote NÃO foi verificado de fato. Devolve null quando o
// antivírus analisou (aí o selo "✓ verificado" é legítimo) ou quando o recurso
// está desligado nesta instalação (não há o que prometer nem o que alertar).
export function scanWarningFor(scanStatus, quantidade) {
  if (scanStatus !== 'degradado') return null;
  return `${quantidade} arquivo(s) anexado(s), mas o antivírus está indisponível: NÃO foi possível verificá-los.`;
}
