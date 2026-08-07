import test from 'node:test';
import assert from 'node:assert/strict';
import { actionForCompanionEvent } from './companionEventActions.js';

test('evento novo de PDF oferece análise executável', () => {
  const action = actionForCompanionEvent({ kind: 'antecipacao_pdf_docling' });
  assert.equal(action?.id, 'analyze_pdf');
  assert.equal(action?.label, 'Analisar PDF');
  assert.match(action?.prompt, /Docling\/OCR/i);
});

test('evento genérico antigo de PDF também recebe botão', () => {
  const action = actionForCompanionEvent({
    kind: 'antecipacao_intencao',
    detail: 'Posso usar o Docling/OCR para analisar este PDF.',
  });
  assert.equal(action?.id, 'analyze_pdf');
});

test('aviso sem ação conhecida continua somente informativo', () => {
  assert.equal(actionForCompanionEvent({ kind: 'tarefa_falhou', detail: 'Falhou.' }), null);
});
