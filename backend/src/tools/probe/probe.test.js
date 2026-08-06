// Testes unitários da sonda de tool calling.
//
// Estes testes não tocam rede nem DB. Validam:
//   1. Classificador: 5 cenários canônicos com fixtures realistas
//      (tool_call nativo, JSON em code block, XML, malformado, no_tool).
//   2. Agregador: veredito a partir de runs sintéticos.
//   3. compareToExpectation: match/não-match com reason legível.
//
// Cenários integrados com provider real só podem rodar com PROBE_LIVE=1 e
// credenciais — não fazem parte desta suíte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolCall, compareToExpectation } from './classifier.js';
import { aggregateRuns, toJSON, toMarkdown } from './results.js';
import { scenarios, getScenarioById } from './scenarios.js';
import { toolSchemas } from './schemas.js';
import { runProbe } from './probeRunner.js';
import { JSONAttempt } from './parseFallback.js';

// ---------- Classifier ----------

test('classifyToolCall: tool_call nativo', () => {
  const response = {
    content: '',
    tool_calls: [
      { function: { name: 'calculator', arguments: '{"a":12,"b":7,"op":"add"}' } },
    ],
  };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'tool_call');
  assert.equal(out.parseSource, 'native');
  assert.equal(out.toolName, 'calculator');
  assert.deepEqual(out.arguments, { a: 12, b: 7, op: 'add' });
});

test('classifyToolCall: tool_call nativo com arguments já em objeto', () => {
  const response = {
    content: '',
    tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }],
  };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'tool_call');
  assert.equal(out.toolName, 'read_file');
  assert.deepEqual(out.arguments, { path: 'README.md' });
});

test('classifyToolCall: arguments inválido vira malformed', () => {
  const response = {
    content: '',
    tool_calls: [{ function: { name: 'calculator', arguments: 'não é json' } }],
  };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'malformed');
  assert.equal(out.parseSource, 'native');
  assert.match(out.parseError, /JSON/);
});

test('classifyToolCall: tool_call extraído de ```json``` no content', () => {
  const response = {
    content: 'Vou usar a calculadora.\n```json\n{"name":"calculator","arguments":{"a":100,"b":58,"op":"subtract"}}\n```',
  };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'tool_call');
  assert.equal(out.parseSource, 'json_block');
  assert.equal(out.toolName, 'calculator');
  assert.deepEqual(out.arguments, { a: 100, b: 58, op: 'subtract' });
});

test('classifyToolCall: tool_call extraído de <tool_call>...</tool_call> com args no corpo', () => {
  const response = {
    content: '<tool_call name="read_file">{"path":"docs/AGENTS.md"}</tool_call>',
  };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'tool_call');
  assert.equal(out.parseSource, 'xml_block');
  assert.equal(out.toolName, 'read_file');
  assert.deepEqual(out.arguments, { path: 'docs/AGENTS.md' });
});

test('classifyToolCall: <tool_call> com args em atributo', () => {
  const response = {
    content: '<tool_call name="list_files" args="{&quot;path&quot;:&quot;.&quot;}"/>',
  };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'tool_call');
  assert.equal(out.parseSource, 'xml_block');
  assert.equal(out.toolName, 'list_files');
  assert.deepEqual(out.arguments, { path: '.' });
});

test('classifyToolCall: nenhum sinal → no_tool', () => {
  const response = { content: 'Claro, posso ajudar! Sobre qual linguagem de programação?' };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'no_tool');
  assert.equal(out.parseSource, 'fallback');
});

test('classifyToolCall: ```json``` sem { name, arguments } → malformed', () => {
  const response = { content: '```json\n{"unrelated": true}\n```' };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'malformed');
  assert.equal(out.parseSource, 'json_block');
  assert.match(out.parseError, /name, arguments/);
});

test('classifyToolCall: tool_call sem nome → malformed', () => {
  const response = {
    content: '',
    tool_calls: [{ function: { arguments: '{"a":1}' } }],
  };
  const out = classifyToolCall(response);
  assert.equal(out.decision, 'malformed');
  assert.match(out.parseError, /name/);
});

// ---------- compareToExpectation ----------

test('compareToExpectation: tool_call bate com argumentos esperados', () => {
  const scenario = getScenarioById('math.simple_addition');
  const classified = {
    decision: 'tool_call',
    toolName: 'calculator',
    arguments: { a: 12, b: 7, op: 'add' },
  };
  const cmp = compareToExpectation(classified, scenario);
  assert.equal(cmp.match, true);
});

test('compareToExpectation: tool_call com argumento divergente → no match', () => {
  const scenario = getScenarioById('math.simple_addition');
  const classified = {
    decision: 'tool_call',
    toolName: 'calculator',
    arguments: { a: 12, b: 7, op: 'multiply' },
  };
  const cmp = compareToExpectation(classified, scenario);
  assert.equal(cmp.match, false);
  assert.match(cmp.reason, /op.*divergente/);
});

test('compareToExpectation: no_tool esperado, modelo chamou tool → no match', () => {
  const scenario = getScenarioById('no_tool.acknowledge_only');
  const classified = {
    decision: 'tool_call',
    toolName: 'calculator',
    arguments: { a: 1, b: 2, op: 'add' },
  };
  const cmp = compareToExpectation(classified, scenario);
  assert.equal(cmp.match, false);
  assert.match(cmp.reason, /esperava no_tool/);
});

test('compareToExpectation: no_tool esperado, modelo respondeu texto → match', () => {
  const scenario = getScenarioById('no_tool.acknowledge_only');
  const classified = { decision: 'no_tool', rawContent: 'posso sim!' };
  const cmp = compareToExpectation(classified, scenario);
  assert.equal(cmp.match, true);
});

test('compareToExpectation: tool_call esperado, veio malformed → no match', () => {
  const scenario = getScenarioById('math.simple_addition');
  const classified = { decision: 'malformed', parseError: 'x' };
  const cmp = compareToExpectation(classified, scenario);
  assert.equal(cmp.match, false);
  assert.match(cmp.reason, /malformed/);
});

// ---------- Agregador ----------

test('aggregateRuns: 0 runs → no_capability', () => {
  const result = aggregateRuns([]);
  assert.equal(result.verdict, 'no_capability');
  assert.equal(result.totals.runs, 0);
});

test('aggregateRuns: nativo em 100% dos runs com_tools → native_supported', () => {
  const runs = [
    {
      scenarioId: 'math.simple_addition',
      mode: 'with_tools',
      classified: { decision: 'tool_call', parseSource: 'native', toolName: 'calculator', arguments: { a: 12, b: 7, op: 'add' } },
      match: true,
      matchReason: 'ok',
      expectedDecision: 'tool_call',
    },
    {
      scenarioId: 'file.find_known_path',
      mode: 'with_tools',
      classified: { decision: 'tool_call', parseSource: 'native', toolName: 'read_file', arguments: { path: 'README.md' } },
      match: true,
      matchReason: 'ok',
      expectedDecision: 'tool_call',
    },
  ];
  const result = aggregateRuns(runs);
  assert.equal(result.verdict, 'native_supported');
  assert.equal(result.totals.toolCalls, 2);
});

test('aggregateRuns: 100% fallback → text_only', () => {
  const runs = [
    {
      scenarioId: 'math.simple_addition',
      mode: 'with_tools',
      classified: { decision: 'no_tool', parseSource: 'fallback', rawContent: '19' },
      match: false,
      matchReason: 'esperava tool_call mas veio no_tool',
      expectedDecision: 'tool_call',
    },
  ];
  const result = aggregateRuns(runs);
  assert.equal(result.verdict, 'text_only');
});

test('aggregateRuns: maioria json_block → json_block', () => {
  const runs = [
    {
      scenarioId: 'math.simple_addition',
      mode: 'with_tools',
      classified: { decision: 'tool_call', parseSource: 'json_block', toolName: 'calculator', arguments: { a: 12, b: 7, op: 'add' } },
      match: true,
      matchReason: 'ok',
      expectedDecision: 'tool_call',
    },
    {
      scenarioId: 'math.simple_subtraction',
      mode: 'with_tools',
      classified: { decision: 'tool_call', parseSource: 'json_block', toolName: 'calculator', arguments: { a: 100, b: 58, op: 'subtract' } },
      match: true,
      matchReason: 'ok',
      expectedDecision: 'tool_call',
    },
    {
      scenarioId: 'no_tool.acknowledge_only',
      mode: 'with_tools',
      classified: { decision: 'no_tool', parseSource: 'fallback' },
      match: true,
      matchReason: 'esperava no_tool',
      expectedDecision: 'no_tool',
    },
  ];
  const result = aggregateRuns(runs);
  assert.equal(result.verdict, 'json_block');
});

test('aggregateRuns: provider error em mais de 50% → no_capability', () => {
  const runs = [
    { scenarioId: 'a', mode: 'with_tools', classified: { decision: 'malformed' }, match: false, matchReason: 'x', providerError: 'timeout' },
    { scenarioId: 'b', mode: 'with_tools', classified: { decision: 'malformed' }, match: false, matchReason: 'x', providerError: 'timeout' },
    { scenarioId: 'c', mode: 'with_tools', classified: { decision: 'tool_call', parseSource: 'native' }, match: true, matchReason: 'ok' },
  ];
  const result = aggregateRuns(runs);
  assert.equal(result.verdict, 'no_capability');
});

// ---------- toJSON / toMarkdown ----------

test('toJSON: serializa sem undefined', () => {
  const runs = [
    { scenarioId: 'a', mode: 'with_tools', classified: { decision: 'no_tool' }, match: false, matchReason: 'x', expectedDecision: 'tool_call' },
  ];
  const result = aggregateRuns(runs);
  const json = toJSON(result);
  assert.equal(typeof json.verdict, 'string');
  // Garante que é JSON válido (não jogou).
  JSON.stringify(json);
});

test('toMarkdown: inclui veredito e tabela', () => {
  const runs = [
    {
      scenarioId: 'math.simple_addition',
      mode: 'with_tools',
      classified: { decision: 'tool_call', parseSource: 'native', toolName: 'calculator', arguments: { a: 12, b: 7, op: 'add' } },
      match: true,
      matchReason: 'ok',
      expectedDecision: 'tool_call',
    },
    {
      scenarioId: 'no_tool.acknowledge_only',
      mode: 'with_tools',
      classified: { decision: 'no_tool', parseSource: 'fallback' },
      match: true,
      matchReason: 'ok',
      expectedDecision: 'no_tool',
    },
  ];
  const result = aggregateRuns(runs);
  const md = toMarkdown(result);
  assert.match(md, /# Tool calling probe — veredito/);
  assert.match(md, /withTools/);
  assert.match(md, /math\.simple_addition/);
});

// ---------- Cenários canônicos (sanity) ----------

test('scenarios: 5 cenários com IDs únicos e formatos válidos', () => {
  assert.equal(scenarios.length, 5);
  const ids = scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, 5);
  for (const s of scenarios) {
    assert.ok(typeof s.userMessage === 'string' && s.userMessage.length > 0);
    assert.ok(Array.isArray(s.tools));
    assert.ok(['tool_call', 'no_tool'].includes(s.expectedDecision));
  }
});

test('toolSchemas: calculator tem campos obrigatórios', () => {
  const calc = toolSchemas.calculator;
  assert.equal(calc.type, 'function');
  assert.equal(calc.function.name, 'calculator');
  const required = calc.function.parameters.required;
  assert.deepEqual(required.sort(), ['a', 'b', 'op']);
});

// ---------- probeRunner dry-run ----------

test('runProbe: dry-run (sem providerFn) retorna verdict e totais coerentes', async () => {
  const result = await runProbe({ turns: 1 });
  assert.ok(['text_only', 'no_capability'].includes(result.verdict));
  // Em dry-run, todos os runs ficam com providerError=null e decision=no_tool.
  // Sem nenhum tool_call, o veredito deve ser 'text_only'.
  assert.equal(result.verdict, 'text_only');
  assert.equal(result.totals.runs, 10); // 5 cenários × 2 modos × 1 turno
  assert.equal(result.totals.toolCalls, 0);
});

test('runProbe: scenarioIds filtra os cenários executados', async () => {
  const result = await runProbe({
    turns: 1,
    scenarioIds: ['math.simple_addition'],
  });
  // 1 cenário × 2 modos × 1 turno = 2 runs
  assert.equal(result.totals.runs, 2);
});

// ---------- JSONAttempt ----------

test('JSONAttempt: parse válido', () => {
  const r = JSONAttempt.safeParse('{"a":1}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1 });
});

test('JSONAttempt: parse inválido não joga', () => {
  const r = JSONAttempt.safeParse('not json');
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
});

test('JSONAttempt: input não-string', () => {
  const r = JSONAttempt.safeParse(null);
  assert.equal(r.ok, false);
});