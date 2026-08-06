import assert from 'node:assert/strict';
import test from 'node:test';
import { contextualSuggestions } from './suggestions.js';

test('sugere backup antes de migration', () => {
  const s = contextualSuggestions({ userText: 'rodar a migration que altera a tabela users' });
  assert.ok(s.some(x => x.id === 'backup_migration'));
});

test('sugere revisão de segurança em mudança de autenticação', () => {
  const s = contextualSuggestions({ userText: 'ajustar o login e o token de sessão' });
  assert.ok(s.some(x => x.id === 'security_review_auth' && x.severity === 'aviso'));
});

test('sugere commit antes de refatoração grande (por contagem de arquivos)', () => {
  const s = contextualSuggestions({ userText: 'mudança geral', changedCount: 10 });
  assert.ok(s.some(x => x.id === 'commit_before_refactor'));
});

test('sugere otimizar prompt longo por tokens', () => {
  const s = contextualSuggestions({ userText: 'faça algo', promptTokens: 2000 });
  assert.ok(s.some(x => x.id === 'optimize_long_prompt'));
});

test('sugere verificação pré-deploy', () => {
  const s = contextualSuggestions({ userText: 'vamos publicar em produção' });
  assert.ok(s.some(x => x.id === 'tests_before_critical'));
});

test('antecipa relatório ou dashboard ao receber CSV financeiro', () => {
  const s = contextualSuggestions({ files: [{ name: 'financeiro-2025.csv' }] });
  const item = s.find(x => x.id === 'csv_next_step');
  assert.ok(item);
  assert.match(item.suggestion, /relatório executivo.*dashboard/i);
});

test('sugere Docling de forma condicional para PDF', () => {
  const s = contextualSuggestions({ files: ['documento.pdf'] });
  const item = s.find(x => x.id === 'pdf_docling');
  assert.ok(item);
  assert.match(item.suggestion, /se ele for escaneado/i);
});

test('propõe delegação para campanha de marketing', () => {
  const s = contextualSuggestions({ userText: 'Crie uma campanha de marketing para este produto' });
  assert.ok(s.some(x => x.id === 'delegate_campaign' && /delegação/i.test(x.suggestion)));
});

test('contexto neutro não gera sugestões irrelevantes', () => {
  const s = contextualSuggestions({ userText: 'oi, tudo bem?' });
  assert.equal(s.length, 0);
});

test('deduplica e nunca quebra com contexto vazio', () => {
  assert.deepEqual(contextualSuggestions({}), []);
  assert.deepEqual(contextualSuggestions(), []);
});
