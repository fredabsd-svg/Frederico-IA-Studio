import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createToolProtocolStreamGuard,
  parseTextToolCalls,
  sanitizeToolProtocolText
} from './toolProtocol.js';

test('converts the Nemotron XML-like tool call into a native call', () => {
  const response = [
    'Vou gerar o documento agora.',
    '<tool_call> <function=run_python> <parameter=code>',
    'from docx import Document',
    "doc = Document()",
    "doc.save('/workspace/outputs/relatorio.docx')",
    '</parameter> </function> </tool_call>'
  ].join('\n');

  const parsed = parseTextToolCalls(response, ['run_python', 'web_search']);

  assert.equal(parsed.detected, true);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.visibleText, 'Vou gerar o documento agora.');
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, 'run_python');
  assert.match(parsed.calls[0].arguments.code, /relatorio\.docx/);
});

test('accepts a JSON tool-call fallback and preserves its arguments', () => {
  const response = '<tool_call>{"name":"web_search","arguments":{"query":"empresa em Miranorte"}}</tool_call>';
  const parsed = parseTextToolCalls(response, ['web_search']);

  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.calls, [{
    name: 'web_search',
    arguments: { query: 'empresa em Miranorte' }
  }]);
});

test('accepts a textual call for a tool that has no arguments', () => {
  const response = '<tool_call><function=list_files></function></tool_call>';
  const parsed = parseTextToolCalls(response, ['list_files']);

  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.calls, [{
    name: 'list_files',
    arguments: {}
  }]);
});

test('rejects textual calls to tools that were not offered', () => {
  const response = '<tool_call><function=delete_everything><parameter=path>/</parameter></function></tool_call>';
  const parsed = parseTextToolCalls(response, ['run_python']);

  assert.equal(parsed.detected, true);
  assert.equal(parsed.malformed, true);
  assert.deepEqual(parsed.calls, []);
});

test('rejects an incomplete textual tool call instead of exposing it', () => {
  const response = 'Preparando.\n<tool_call><function=run_python><parameter=code>print(1)';
  const parsed = parseTextToolCalls(response, ['run_python']);

  assert.equal(parsed.detected, true);
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.visibleText, 'Preparando.');
});

test('stream guard hides a protocol marker even when it is split across chunks', () => {
  const guard = createToolProtocolStreamGuard(true);
  const visible = [
    guard.push('Vou criar o arquivo.'),
    guard.push('\n<tool_'),
    guard.push('call><function=run_python>'),
    guard.push('<parameter=code>print(1)</parameter></function></tool_call>'),
    guard.finish()
  ].join('');

  assert.equal(visible, 'Vou criar o arquivo.');
  assert.equal(guard.suppressed, true);
  assert.doesNotMatch(visible, /tool_call|run_python|print/);
});

test('stream guard suppresses leaked protocol even in no-tools mode', () => {
  // Regressão do bug de produção (consulta de CNPJ): no modo SEM ferramentas o
  // guard repassava tudo, então <tool_call>/<function=>/código python vazavam.
  const guard = createToolProtocolStreamGuard(false);
  const parts = [
    'Vou criar o relatório.',
    '\n<tool_call>\n<function=run_python>\n<parameter=code>\n',
    'from docx import Document\ndoc = Document()\ndoc.save("/workspace/outputs/x.docx")\n',
    '</parameter>\n</function>\n</tool_call>'
  ];
  let visible = '';
  for (const p of parts) visible += guard.push(p);
  visible += guard.finish();
  assert.equal(visible, 'Vou criar o relatório.');
  assert.equal(guard.suppressed, true);
  assert.doesNotMatch(visible, /tool_call|function=|from docx|doc\.save/);
});

test('stream guard leaves an ordinary response unchanged', () => {
  const guard = createToolProtocolStreamGuard(true);
  const original = 'Relatorio concluido com sucesso e pronto para download.';
  const visible = guard.push(original.slice(0, 20)) + guard.push(original.slice(20)) + guard.finish();

  assert.equal(visible, original);
  assert.equal(guard.suppressed, false);
});

test('sanitizes old saved responses while preserving the useful notice', () => {
  const response = [
    '<tool_call><function=run_python><parameter=code>print("segredo tecnico")</parameter></function></tool_call>',
    '',
    'Nota: nenhum arquivo foi criado nesta tentativa.'
  ].join('\n');

  const sanitized = sanitizeToolProtocolText(response);

  assert.equal(sanitized, 'Nota: nenhum arquivo foi criado nesta tentativa.');
  assert.doesNotMatch(sanitized, /tool_call|run_python|segredo tecnico/);
});
