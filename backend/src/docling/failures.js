// Taxonomia de falhas do Docling (seção "Tratamento de falhas"). Em vez de um
// "falhou" genérico, classifica o motivo a partir da mensagem de erro e devolve
// um rótulo claro, o que fazer e se vale tentar de novo. Nunca apresentamos uma
// extração incompleta como se estivesse completa — o usuário sabe exatamente o
// que aconteceu. Lógica PURA (testável).

const RULES = [
  {
    kind: 'protegido',
    re: /password|encrypt|senha|protegid|decrypt/i,
    label: 'Documento protegido por senha',
    suggestion: 'Remova a proteção/senha do PDF e envie novamente.',
    canRetry: false,
  },
  {
    kind: 'formato_nao_suportado',
    re: /unsupported|not supported|formato n[aã]o|cannot open|no such format|invalid format/i,
    label: 'Formato não suportado',
    suggestion: 'Converta o arquivo para PDF (ou outro formato suportado) e reenvie.',
    canRetry: false,
  },
  {
    kind: 'corrompido',
    re: /corrupt|damaged|malformed|broken|unexpected eof|not a pdf|invalid pdf|arquivo inv[aá]lido/i,
    label: 'Arquivo corrompido',
    suggestion: 'O arquivo parece danificado. Gere-o novamente na origem e reenvie.',
    canRetry: true,
  },
  {
    kind: 'timeout',
    re: /timeout|timed out|prazo|deadline/i,
    label: 'Tempo de processamento esgotado',
    suggestion: 'Documento muito grande/pesado. Reprocesse, ou reduza o limite de páginas na configuração.',
    canRetry: true,
  },
  {
    kind: 'ocr_falhou',
    re: /\bocr\b|tesseract|rapidocr/i,
    label: 'Falha no OCR',
    suggestion: 'Reprocesse com OCR "sempre" ou revise o idioma do OCR nas configurações.',
    canRetry: true,
  },
  {
    kind: 'tabela_falhou',
    re: /table structure|tableformer|extra[cç][aã]o de tabela/i,
    label: 'Falha na extração de tabelas',
    suggestion: 'O texto foi extraído, mas as tabelas podem estar incompletas. Confira no documento original.',
    canRetry: true,
  },
  {
    kind: 'servico_indisponivel',
    re: /econn|fetch failed|http 5\d\d|connection|indispon[ií]vel|n[aã]o retornou|socket|network|unreachable/i,
    label: 'Serviço de documentos indisponível',
    suggestion: 'O serviço do Docling pode estar fora do ar ou carregando os modelos. Tente novamente em instantes.',
    canRetry: true,
  },
  {
    kind: 'cancelado',
    re: /cancel/i,
    label: 'Processamento cancelado',
    suggestion: 'O processamento foi interrompido. Reprocesse se ainda precisar.',
    canRetry: true,
  },
];

export function classifyFailure(message = '') {
  const m = String(message || '');
  for (const r of RULES) {
    if (r.re.test(m)) return { kind: r.kind, label: r.label, suggestion: r.suggestion, canRetry: r.canRetry };
  }
  return {
    kind: 'desconhecido',
    label: 'Não foi possível processar o documento',
    suggestion: 'Tente reprocessar. Se persistir, o modelo ainda pode ler o arquivo pelo método tradicional.',
    canRetry: true,
  };
}
