import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlanUpdate, shouldOfferUpdatePlan, updatePlanToolDefinition, UPDATE_PLAN_TOOL_NAME, PLAN_STEP_STATUSES } from './planTool.js';

test('plano válido é normalizado com ids estáveis e evidência preservada', () => {
  const { plan, error } = normalizePlanUpdate({ steps: [
    { title: 'Mapear fluxo atual', status: 'completed', evidence: 'grep em routes/: 3 arquivos lidos' },
    { title: 'Corrigir callback', status: 'running' },
    { id: 'testes', title: 'Rodar a suíte', status: 'pending' }
  ] });
  assert.equal(error, undefined);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0].evidence, 'grep em routes/: 3 arquivos lidos');
  assert.equal(plan.steps[1].id, '2');
  assert.equal(plan.steps[2].id, 'testes');
  assert.ok(plan.updatedAt);
});

test('completed sem evidência é recusado — sem sucesso falso no plano', () => {
  const { error } = normalizePlanUpdate({ steps: [{ title: 'Corrigir bug', status: 'completed' }] });
  assert.match(error, /evidência/);
});

test('status inválido, plano vazio e excesso de passos são recusados', () => {
  assert.match(normalizePlanUpdate({ steps: [{ title: 'x', status: 'done' }] }).error, /Status inválido/);
  assert.match(normalizePlanUpdate({}).error, /lista completa/);
  const many = Array.from({ length: 31 }, (_, i) => ({ title: `p${i}`, status: 'pending' }));
  assert.match(normalizePlanUpdate({ steps: many }).error, /máximo/);
});

test('ids duplicados são desambiguados em vez de sobrescrever', () => {
  const { plan } = normalizePlanUpdate({ steps: [
    { id: 'a', title: 'um', status: 'pending' },
    { id: 'a', title: 'dois', status: 'pending' }
  ] });
  assert.notEqual(plan.steps[0].id, plan.steps[1].id);
});

test('a ferramenta só é oferecida em missão de desenvolvimento do agente principal', () => {
  const dev = { canWrite: true };
  assert.equal(shouldOfferUpdatePlan({ developerContext: dev, hasTools: true }), true);
  assert.equal(shouldOfferUpdatePlan({ developerContext: null, hasTools: true }), false);
  assert.equal(shouldOfferUpdatePlan({ developerContext: dev, hasTools: true, isSubagent: true }), false);
  assert.equal(shouldOfferUpdatePlan({ developerContext: dev, hasTools: true, lowSignalTurn: true }), false);
  assert.equal(shouldOfferUpdatePlan({ developerContext: dev, hasTools: false }), false);
});

test('a definição da ferramenta declara os status e a regra de evidência', () => {
  assert.equal(updatePlanToolDefinition.function.name, UPDATE_PLAN_TOOL_NAME);
  const statusEnum = updatePlanToolDefinition.function.parameters.properties.steps.items.properties.status.enum;
  assert.deepEqual(statusEnum, [...PLAN_STEP_STATUSES]);
  assert.match(updatePlanToolDefinition.function.description, /completed.*evidence/i);
});
