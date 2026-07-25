import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBug, guessSeverity, extractFiles } from './bugAnalysis.js';
import { reportRelPath, incidentReportMarkdown } from './reports.js';

test('guessSeverity classifica pela natureza', () => {
  assert.equal(guessSeverity('FATAL: segfault'), 'critica');
  assert.equal(guessSeverity('Error: algo falhou'), 'alta');
  assert.equal(guessSeverity('WARN: deprecated'), 'media');
  assert.equal(guessSeverity('tudo ok'), 'baixa');
});

test('extractFiles pega arquivos/linhas do stack (Node e Python), ignora libs', () => {
  const node = 'Error: x\n    at f (/app/src/db.js:42:5)\n    at g (/app/node_modules/pg/index.js:10:1)';
  const fn = extractFiles(node);
  assert.deepEqual(fn, [{ file: '/app/src/db.js', lines: [42] }]);
  const py = 'Traceback:\n  File "/app/main.py", line 12, in <module>\n  File "/usr/lib/site-packages/x.py", line 3';
  const fp = extractFiles(py);
  assert.deepEqual(fp, [{ file: '/app/main.py', lines: [12] }]);
});

test('analyzeBug identifica causa e evidências com confiança', () => {
  const a = analyzeBug({ errorMessage: 'ECONNREFUSED 127.0.0.1:5432', stack: 'at conn (/app/src/db.js:8:3)' });
  assert.equal(a.causeKind, 'infra');
  assert.match(a.probableCause, /Conex[aã]o recusada/i);
  assert.equal(a.severity, 'alta');
  assert.equal(a.firstFrame.file, '/app/src/db.js');
  assert.ok(a.confidence >= 70);
});

test('analyzeBug sem padrão conhecido tem baixa confiança (transparência)', () => {
  const a = analyzeBug({ errorMessage: 'algo muito específico e novo' });
  assert.equal(a.causeKind, 'desconhecido');
  assert.ok(a.confidence <= 40);
});

test('reportRelPath organiza por projeto/ano/mês/dia/severidade', () => {
  const p = reportRelPath({ id: 'abc', project: 'app x', severity: 'alta', kind: 'bug', createdAt: '2026-07-23T12:00:00Z' });
  assert.equal(p, 'relatorios/app_x/2026/07/23/alta/bug_abc.md');
});

test('incidentReportMarkdown inclui os campos principais', () => {
  const md = incidentReportMarkdown({
    id: 'i1', summary: 'Falha no banco', severity: 'alta', kind: 'bug',
    errorMessage: 'ECONNREFUSED', probableCause: 'Conexão recusada', confidence: 70,
    relatedFiles: [{ file: '/app/db.js', lines: [8] }], commands: ['docker compose up -d postgres'],
  }, { similar: [] });
  assert.match(md, /# Diagnóstico/);
  assert.match(md, /Conexão recusada/);
  assert.match(md, /\/app\/db\.js:8/);
  assert.match(md, /docker compose up/);
});
