import assert from 'node:assert/strict';
import test from 'node:test';
import { incidentSignature } from './incidents.js';

// A assinatura de correlação é o que liga um erro novo aos anteriores ("esse
// erro já ocorreu antes"). Variações do mesmo erro (ts/ids/caminhos) colapsam na
// mesma assinatura; erros diferentes geram assinaturas diferentes.

test('mesmo erro com detalhes variáveis gera a MESMA assinatura', () => {
  const a = incidentSignature({ errorMessage: '2026-07-23T10:00 ERROR conexão recusada em /app/db.js:42 (id 9f3a2b1c)' });
  const b = incidentSignature({ errorMessage: '2026-07-23T11:59 ERROR conexão recusada em /srv/db.js:88 (id aa11bb22)' });
  assert.equal(a, b);
  assert.ok(a && a.length > 0);
});

test('erros diferentes geram assinaturas diferentes', () => {
  const a = incidentSignature({ errorMessage: 'ECONNREFUSED no banco' });
  const b = incidentSignature({ errorMessage: 'NullPointerException no parser' });
  assert.notEqual(a, b);
});

test('usa a assinatura explícita quando fornecida', () => {
  assert.equal(incidentSignature({ signature: 'sig-fixa', errorMessage: 'qualquer' }), 'sig-fixa');
});

test('deriva do summary quando não há errorMessage', () => {
  const s = incidentSignature({ summary: 'timeout na fila de tarefas' });
  assert.ok(s && s.length > 0);
});
