const PDF_ANALYSIS_PROMPT = 'Analise o(s) PDF(s) anexado(s) nesta conversa. Use o conteúdo extraído pelo Docling/OCR quando estiver disponível, confira tabelas e páginas escaneadas e informe claramente qualquer limitação de leitura.';

// Eventos antigos usavam o tipo genérico `antecipacao_intencao`. O fallback pelo
// conteúdo mantém o botão disponível para avisos criados antes desta correção.
export function actionForCompanionEvent(event = {}) {
  const kind = String(event.kind || '');
  const detail = String(event.detail || '');
  const isPdf = kind === 'antecipacao_pdf_docling'
    || (kind === 'antecipacao_intencao' && /\bPDF\b|Docling|OCR/i.test(detail));
  if (!isPdf) return null;
  return {
    id: 'analyze_pdf',
    label: 'Analisar PDF',
    pendingLabel: 'Iniciando análise…',
    prompt: PDF_ANALYSIS_PROMPT,
  };
}
