// F-24: orçamento por delegação. Cobre a função pura `buildSubagentBudget` e
// a integração mínima com o loop (tetos default vs overrides).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubagentBudget, SUBAGENT_DEFAULTS } from './agent/subagents.js';

test('buildSubagentBudget devolve os defaults quando nada é informado', () => {
  const b = buildSubagentBudget({ now: 1000 });
  assert.equal(b.maxSteps, SUBAGENT_DEFAULTS.maxSteps);
  assert.equal(b.hardMaxSteps, SUBAGENT_DEFAULTS.hardMaxSteps);
  assert.equal(b.maxTokens, SUBAGENT_DEFAULTS.maxTokens);
});

test('buildSubagentBudget ancora o deadline em now + totalMs', () => {
  const now = 1700000000000;
  const b = buildSubagentBudget({ now, totalMs: 60000 });
  assert.equal(b.deadlineMs, now + 60000);
});

test('buildSubagentBudget respeita deadlineMs explícito (compartilhado entre paralelas)', () => {
  // Quando o pai quer que duas delegações paralelas compartilhem o MESMO
  // deadline, ele passa um `deadlineMs` calculado uma vez. Aqui a função
  // só repassa — é o ponto de contrato.
  const deadline = 1700000005000;
  const b = buildSubagentBudget({ now: 1700000000000, deadlineMs: deadline });
  assert.equal(b.deadlineMs, deadline);
});

test('SUBAGENT_DEFAULTS tem valores finitos e não-zero', () => {
  // Garantia contra regressões do tipo "alguém zera o env e o sub-agente
  // roda sem teto". Defaults sensatos SEMPRE devem existir.
  for (const k of ['maxSteps', 'hardMaxSteps', 'maxTokens', 'totalMs']) {
    assert.ok(Number.isFinite(SUBAGENT_DEFAULTS[k]), `${k} deve ser finito`);
    assert.ok(SUBAGENT_DEFAULTS[k] > 0, `${k} deve ser > 0`);
  }
  assert.ok(SUBAGENT_DEFAULTS.maxSteps > 2, 'um subagente deve poder concluir missões com mais de duas etapas');
  assert.ok(SUBAGENT_DEFAULTS.hardMaxSteps > 2, 'o teto duro não pode reintroduzir o corte histórico em duas etapas');
});

test('SUBAGENT_DEFAULTS.totalMs é maior que o timeout duro do stream (defesa em profundidade)', () => {
  // O timeout duro do stream é 30s (streamGuard.js). Se o totalMs default
  // ficasse abaixo disto, o stream morreria antes do budget expirar — e o
  // budget seria inútil. Aqui só cobrirmos o limite inferior razoável.
  assert.ok(SUBAGENT_DEFAULTS.totalMs >= 60000, 'totalMs >= 60s');
});
